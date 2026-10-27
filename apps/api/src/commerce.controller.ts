import {
  BadRequestException, Body, Controller, Get, NotFoundException, Param, Patch, Post, Query, Req, UseGuards
} from "@nestjs/common";
import { AuthGuard, requireStaff, type UserRequest } from "./auth.guard.js";
import { integerField, object, stringField } from "./input.js";
import { PrismaService } from "./prisma.service.js";
import { withUserLock } from "./user-transaction.js";
import { visibleRoom } from "./room-access.js";

@Controller()
@UseGuards(AuthGuard)
export class CommerceController {
  constructor(private readonly prisma: PrismaService) {}

  @Get("points/me")
  async myPoints(@Req() request: UserRequest) {
    const userId = request.currentUser.id;
    const [user, entries] = await Promise.all([
      this.prisma.user.findUniqueOrThrow({ where: { id: userId }, select: { pointsBalance: true } }),
      this.prisma.pointLedger.findMany({ where: { userId }, orderBy: { createdAt: "desc" }, take: 20 })
    ]);
    return { balance: user.pointsBalance, entries };
  }

  @Get("coupons")
  coupons(@Req() request: UserRequest) {
    return this.prisma.coupon.findMany({
      where: { expiresAt: { gt: new Date() }, ...(request.currentUser.role === "STUDENT" ? { room: { status: { not: "DRAFT" } } } : {}) },
      include: { store: { select: { name: true } }, room: { select: { title: true } } },
      orderBy: { createdAt: "desc" }
    });
  }

  @Get("coupons/mine")
  myCoupons(@Req() request: UserRequest) {
    return this.prisma.userCoupon.findMany({
      where: { userId: request.currentUser.id, ...(request.currentUser.role === "STUDENT" ? { coupon: { room: { status: { not: "DRAFT" } } } } : {}) },
      include: { coupon: true }, orderBy: { claimedAt: "desc" }
    });
  }

  @Post("coupons")
  async createCoupon(@Req() request: UserRequest, @Body() body: unknown) {
    requireStaff(request.currentUser);
    const input = object(body);
    const storeId = stringField(input, "storeId", 100);
    if (!(await this.prisma.store.findUnique({ where: { id: storeId } }))) throw new NotFoundException("店铺不存在");
    const roomId = stringField(input, "roomId", 100);
    const room = await this.prisma.room.findUnique({ where: { id: roomId } });
    if (!room || room.storeId !== storeId) throw new BadRequestException("直播间不属于所选店铺");
    const expiresAt = new Date(stringField(input, "expiresAt", 40));
    if (Number.isNaN(expiresAt.getTime()) || expiresAt.getTime() <= Date.now()) {
      throw new BadRequestException("优惠券有效期不正确");
    }
    return this.prisma.coupon.create({ data: {
      storeId,
      roomId,
      name: stringField(input, "name", 80),
      pointsDiscount: integerField(input, "pointsDiscount", 1, 1_000_000),
      expiresAt
    } });
  }

  @Post("coupons/:id/claim")
  async claimCoupon(@Req() request: UserRequest, @Param("id") id: string) {
    const coupon = await this.prisma.coupon.findUnique({ where: { id }, include: { room: true } });
    if (!coupon || coupon.expiresAt.getTime() <= Date.now()) throw new NotFoundException("优惠券不存在或已过期");
    visibleRoom(coupon.room, request.currentUser.role);
    return this.prisma.userCoupon.upsert({
      where: { userId_couponId: { userId: request.currentUser.id, couponId: id } },
      update: {},
      create: { userId: request.currentUser.id, couponId: id }
    });
  }

  @Patch("coupons/:id/expire")
  async expireCoupon(@Req() request: UserRequest, @Param("id") id: string) {
    requireStaff(request.currentUser);
    const result = await this.prisma.coupon.updateMany({ where: { id, expiresAt: { gt: new Date() } }, data: { expiresAt: new Date() } });
    if (!result.count) throw new NotFoundException("优惠券不存在或已停用");
    return { expired: true };
  }

  @Get("staff/overview")
  async staffOverview(@Req() request: UserRequest) {
    requireStaff(request.currentUser);
    return { pendingOrders: await this.prisma.order.count({ where: { status: { in: ["PENDING_PICKUP", "PENDING_DELIVERY"] } } }) };
  }

  @Get("orders")
  async orders(@Req() request: UserRequest, @Query() query: Record<string, unknown>) {
    const page = query.page === undefined ? 1 : Number(query.page);
    if (!Number.isSafeInteger(page) || page < 1 || page > 100_000) throw new BadRequestException("页码不正确");
    const where = { userId: request.currentUser.id };
    const [items, total] = await this.prisma.$transaction([
      this.prisma.order.findMany({
        where, include: { items: true, coupon: { select: { name: true } } },
        orderBy: { createdAt: "desc" }, skip: (page - 1) * 20, take: 20
      }),
      this.prisma.order.count({ where })
    ]);
    return { items, total, page, pageSize: 20 };
  }

  @Post("orders")
  async createOrder(@Req() request: UserRequest, @Body() body: unknown) {
    const input = object(body);
    const couponId = input.couponId === undefined || input.couponId === null || input.couponId === ""
      ? undefined : stringField(input, "couponId", 100);
    const userId = request.currentUser.id;
    const requestKey = stringField(input, "requestKey", 100);
    const expectedPointsTotal = integerField(input, "expectedPointsTotal", 0, 2_000_000_000);
    if (!/^[a-zA-Z0-9-]{16,100}$/.test(requestKey)) throw new BadRequestException("订单提交标识不正确");
    const fulfillmentMethod = input.fulfillmentMethod === undefined ? "PICKUP" : input.fulfillmentMethod;
    if (fulfillmentMethod !== "PICKUP" && fulfillmentMethod !== "DELIVERY") throw new BadRequestException("交付方式不正确");
    if (fulfillmentMethod === "DELIVERY" && (typeof input.deliveryAddress !== "string" || !input.deliveryAddress.trim())) {
      throw new BadRequestException("请填写送货地点");
    }
    const deliveryAddress = fulfillmentMethod === "DELIVERY" ? stringField(input, "deliveryAddress", 200) : null;
    return withUserLock(this.prisma, userId, async (tx) => {
      const previous = await tx.order.findUnique({ where: { userId_requestKey: { userId, requestKey } }, include: { items: true } });
      if (previous) {
        if (previous.couponId !== (couponId ?? null) || previous.pointsTotal !== expectedPointsTotal ||
            previous.fulfillmentMethod !== fulfillmentMethod || previous.deliveryAddress !== deliveryAddress) {
          throw new BadRequestException("该提交标识已用于其他订单，请刷新后重试");
        }
        return previous;
      }
      const cart = await tx.cartItem.findMany({ where: { userId }, include: { product: { include: { rooms: true } } } });
      if (cart.length === 0) throw new BadRequestException("小黄车是空的");
      if (cart.some((item) => !item.product.isActive || !item.product.rooms.length)) throw new BadRequestException("部分商品已下架或移出直播间，请先移除");
      if (request.currentUser.role === "STUDENT") {
        const roomIds = [...new Set(cart.flatMap((item) => item.product.rooms.map((binding) => binding.roomId)))];
        const visible = await tx.room.findMany({ where: { id: { in: roomIds }, status: { not: "DRAFT" } }, select: { id: true } });
        const visibleIds = new Set(visible.map((room) => room.id));
        if (cart.some((item) => !item.product.rooms.some((binding) => visibleIds.has(binding.roomId)))) {
          throw new BadRequestException("部分商品所在课堂尚未开放，请先移除");
        }
      }
      const pointsSubtotal = cart.reduce((sum, item) => sum + item.product.pointsPrice * item.quantity, 0);
      if (cart.some((item) => item.quantity < 1 || item.quantity > 99) || pointsSubtotal > 2_000_000_000) {
        throw new BadRequestException("商品数量或积分金额超限，请调整购物车");
      }
      let pointsDiscount = 0;
      if (couponId) {
        const claimed = await tx.userCoupon.findUnique({
          where: { userId_couponId: { userId, couponId } }, include: { coupon: { include: { room: true } } }
        });
        if (!claimed || claimed.usedAt || claimed.coupon.expiresAt.getTime() <= Date.now()) {
          throw new BadRequestException("优惠券不可使用");
        }
        visibleRoom(claimed.coupon.room, request.currentUser.role);
        const eligible = cart.filter((item) => item.product.storeId === claimed.coupon.storeId &&
          item.product.rooms.some((binding) => binding.roomId === claimed.coupon.roomId))
          .reduce((sum, item) => sum + item.product.pointsPrice * item.quantity, 0);
        if (eligible === 0) throw new BadRequestException("小黄车没有适用该优惠券的商品");
        pointsDiscount = Math.min(eligible, claimed.coupon.pointsDiscount);
      }
      const pointsTotal = pointsSubtotal - pointsDiscount;
      if (pointsTotal !== expectedPointsTotal) throw new BadRequestException("兑换积分已变化，请刷新购物车后重新确认");
      const user = await tx.user.findUniqueOrThrow({ where: { id: userId } });
      if (user.pointsBalance < pointsTotal) throw new BadRequestException("积分不足，请联系管理员充值");
      const order = await tx.order.create({
        data: {
          userId, requestKey, couponId, pointsSubtotal, pointsDiscount, pointsTotal, fulfillmentMethod,
          deliveryAddress, status: fulfillmentMethod === "PICKUP" ? "PENDING_PICKUP" : "PENDING_DELIVERY",
          items: { create: cart.map((item) => ({
            productId: item.productId,
            name: item.product.name,
            pointsPrice: item.product.pointsPrice,
            pickupPoint: item.product.pickupPoint,
            quantity: item.quantity
          })) }
        },
        include: { items: true }
      });
      if (couponId) {
        const result = await tx.userCoupon.updateMany({ where: { userId, couponId, usedAt: null }, data: { usedAt: new Date() } });
        if (result.count !== 1) throw new BadRequestException("优惠券已使用");
      }
      const updated = await tx.user.update({ where: { id: userId }, data: { pointsBalance: { decrement: pointsTotal } } });
      await tx.pointLedger.create({ data: { userId, delta: -pointsTotal, balanceAfter: updated.pointsBalance, reason: "商品积分兑换", orderId: order.id, requestKey } });
      await tx.cartItem.deleteMany({ where: { userId } });
      return order;
    });
  }

  @Patch("staff/orders/:id/complete")
  async completeOrder(@Req() request: UserRequest, @Param("id") id: string) {
    requireStaff(request.currentUser);
    const result = await this.prisma.order.updateMany({ where: { id, status: { in: ["PENDING_PICKUP", "PENDING_DELIVERY"] } }, data: { status: "COMPLETED" } });
    if (!result.count) throw new BadRequestException("订单不存在或已完成");
    return { ok: true };
  }

  @Get("staff/orders")
  async staffOrders(@Req() request: UserRequest, @Query() query: Record<string, unknown>) {
    requireStaff(request.currentUser);
    const page = query.page === undefined ? 1 : Number(query.page);
    if (!Number.isSafeInteger(page) || page < 1 || page > 100_000) throw new BadRequestException("页码不正确");
    const q = typeof query.q === "string" ? query.q.trim().slice(0, 100) : "";
    const where = q ? { OR: [
      { id: { contains: q } }, { user: { email: { contains: q } } }, { user: { displayName: { contains: q } } },
      { items: { some: { name: { contains: q } } } }
    ] } : {};
    const [items, total] = await this.prisma.$transaction([
      this.prisma.order.findMany({ where, include: { items: true, coupon: { select: { name: true } }, user: { select: { id: true, email: true, displayName: true } } }, orderBy: { createdAt: "desc" }, skip: (page - 1) * 20, take: 20 }),
      this.prisma.order.count({ where })
    ]);
    return { items, total, page, pageSize: 20 };
  }
}
