import { randomBytes } from "node:crypto";
import { BadRequestException, Body, Controller, Delete, ForbiddenException, Get, NotFoundException, Param, Patch, Post, Query, Req, Res, ServiceUnavailableException, UseGuards } from "@nestjs/common";
import type { Request, Response } from "express";
import type { UserRequest } from "./auth.guard.js";
import { AuthGuard, isAdminRole, requireStaff } from "./auth.guard.js";
import { AuditService } from "./audit.service.js";
import { hashPassword } from "./auth.service.js";
import { integerField, object, optionalString, stringField } from "./input.js";
import { PrismaService } from "./prisma.service.js";
import { StorageService } from "./storage.service.js";
import type { Product } from "./generated/prisma/client.js";
import { withUserLock } from "./user-transaction.js";
import { visibleRoom } from "./room-access.js";
import { dataScope, isTestCreator, sameSideCreate, scoped, assertSameSide } from "./data-scope.js";
import { publishToken } from "./cloud-webhook.controller.js";
import { ChatGateway } from "./chat.gateway.js";

const DETAIL_IMAGE_KEY_PATTERN = /^product-images\/[a-f0-9]{32}\.(jpg|png|webp)$/;
export const MAX_DETAIL_IMAGES = 9;

export function detailImageKeys(input: Record<string, unknown>): string[] | undefined {
  const value = input.detailImages;
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) throw new BadRequestException("详情图片格式不正确");
  if (value.length > MAX_DETAIL_IMAGES) throw new BadRequestException(`详情图片最多 ${MAX_DETAIL_IMAGES} 张`);
  return value.map((key): string => {
    if (typeof key !== "string" || !DETAIL_IMAGE_KEY_PATTERN.test(key)) throw new BadRequestException("详情图片对象键不正确");
    return key;
  });
}

function liveDomain(): string {
  const value = process.env.APP_DOMAIN;
  if (!value || value.includes("example.com")) throw new ServiceUnavailableException("请先配置 APP_DOMAIN");
  return value;
}

type ProductWithDetailImages = Product & { detailImages: { imageKey: string }[] };

@Controller()
@UseGuards(AuthGuard)
export class BusinessController {
  constructor(private readonly prisma: PrismaService, private readonly storage: StorageService, private readonly audit: AuditService, private readonly chat: ChatGateway) {}

  private withImage<T extends ProductWithDetailImages>(product: T): Omit<T, "detailImages"> & { detailImageKeys: string[] } {
    const { detailImages, ...rest } = product;
    return {
      ...rest,
      ...(rest.imageKey ? { imageUrl: `/api/product-images/${rest.id}` } : {}),
      detailImageKeys: detailImages.map((item) => item.imageKey)
    };
  }

  @Post("users")
  async createUser(@Req() request: UserRequest, @Body() body: unknown) {
    if (!isAdminRole(request.currentUser.role)) throw new ForbiddenException("仅管理员可创建账号");
    const input = object(body);
    const email = stringField(input, "email", 100).toLowerCase();
    const password = stringField(input, "password", 200);
    if (!/^[a-zA-Z0-9._@-]{2,100}$/.test(email)) throw new BadRequestException("账号仅支持字母、数字、点、下划线、@、中划线");
    if (password.length < 6) throw new BadRequestException("初始密码至少 6 位");
    const role = input.role;
    if (role !== "TEACHER" && role !== "STUDENT") throw new BadRequestException("角色不正确");
    if (await this.prisma.user.findUnique({ where: { email } })) throw new BadRequestException("该账号已存在");
    const created = await this.prisma.user.create({
      data: { email, displayName: optionalString(input, "displayName", 80) || email, passwordHash: await hashPassword(password), role, isTest: isTestCreator(request.currentUser), mustChangePassword: true },
      select: { id: true, email: true, displayName: true, role: true, createdAt: true }
    });
    await this.audit.log({ action: "USER_CREATED", userId: created.id, actorName: request.currentUser.displayName, request, detail: `${request.currentUser.displayName} 创建了${role === "TEACHER" ? "教师" : "学生"}账号 ${email}` });
    return created;
  }

  @Get("product-images/:id")
  async productImage(@Req() request: UserRequest, @Param("id") id: string, @Res() response: Response) {
    void request;
    const product = scoped(await this.prisma.product.findUnique({ where: { id } }), request.currentUser, "商品图片不存在");
    if (!product.imageKey) throw new NotFoundException("商品图片不存在");
    const { stream, contentType } = await this.storage.getImageStream(product.imageKey);
    response.status(200);
    response.setHeader("Content-Type", contentType);
    response.setHeader("Cache-Control", "private, max-age=86400");
    stream.pipe(response);
  }

  @Get("products/:id/detail-images/:index")
  async productDetailImage(@Req() request: UserRequest, @Param("id") id: string, @Param("index") index: string, @Res() response: Response) {
    const product = scoped(await this.prisma.product.findUnique({
      where: { id }, select: { id: true, isTest: true, detailImages: { select: { imageKey: true }, orderBy: { position: "asc" } } }
    }), request.currentUser, "商品图片不存在");
    const order = Number(index);
    if (!Number.isInteger(order) || order < 0 || order >= product.detailImages.length) throw new NotFoundException("商品图片不存在");
    const { stream, contentType } = await this.storage.getImageStream(product.detailImages[order].imageKey);
    response.status(200);
    response.setHeader("Content-Type", contentType);
    response.setHeader("Cache-Control", "private, max-age=86400");
    stream.pipe(response);
  }

  @Get("stores")
  stores(@Req() request: UserRequest) {
    return this.prisma.store.findMany({ where: dataScope(request.currentUser), orderBy: { createdAt: "desc" } });
  }

  @Post("stores")
  createStore(@Req() request: UserRequest, @Body() body: unknown) {
    requireStaff(request.currentUser);
    const input = object(body);
    return this.prisma.store.create({
      data: { name: stringField(input, "name", 80), isTest: isTestCreator(request.currentUser), description: optionalString(input, "description") ?? "" }
    });
  }

  @Get("rooms")
  async rooms(@Req() request: UserRequest) {
    const rooms = await this.prisma.room.findMany({ where: { ...(request.currentUser.role === "STUDENT" ? { status: { not: "DRAFT" } } : {}), ...dataScope(request.currentUser) ?? {} }, include: {
      store: { select: { id: true, name: true } },
      _count: { select: { products: { where: { product: { isActive: true } } }, coupons: { where: { expiresAt: { gt: new Date() } } }, recordings: { where: { expiresAt: { gt: new Date() }, objectKey: { endsWith: ".mp4" } } } } }
    }, orderBy: { createdAt: "desc" } });
    return rooms.map(({ _count, ...room }) => ({ ...room, productCount: _count.products, couponCount: _count.coupons, recordingCount: _count.recordings }));
  }

  @Patch("stores/:id")
  async updateStore(@Req() request: UserRequest, @Param("id") id: string, @Body() body: unknown) {
    requireStaff(request.currentUser);
    const input = object(body);
    scoped(await this.prisma.store.findUnique({ where: { id } }), request.currentUser, "店铺不存在");
    return this.prisma.store.update({ where: { id }, data: {
      name: stringField(input, "name", 80), description: optionalString(input, "description") ?? ""
    } });
  }

  @Get("rooms/:id")
  async room(@Param("id") id: string, @Req() request: UserRequest) {
    const room = await this.prisma.room.findUnique({ where: { id }, include: { store: true } });
    return visibleRoom(room, request.currentUser);
  }

  @Post("rooms")
  async createRoom(@Req() request: UserRequest, @Body() body: unknown) {
    requireStaff(request.currentUser);
    const input = object(body);
    const storeId = stringField(input, "storeId", 100);
    sameSideCreate(scoped(await this.prisma.store.findUnique({ where: { id: storeId } }), request.currentUser, "店铺不存在"), request.currentUser);
    return this.prisma.room.create({
      data: { storeId, title: stringField(input, "title", 100), isTest: isTestCreator(request.currentUser), streamName: randomBytes(12).toString("hex") }
    });
  }

  @Patch("rooms/:id")
  async updateRoom(@Req() request: UserRequest, @Param("id") id: string, @Body() body: unknown) {
    requireStaff(request.currentUser);
    const input = object(body);
    const title = optionalString(input, "title", 100);
    if (title !== undefined && !title) throw new BadRequestException("直播间标题不能为空");
    const status = input.status;
    if (status !== undefined && !["DRAFT", "READY", "ENDED"].includes(String(status))) {
      throw new BadRequestException("直播中状态由云推流回调更新，不能手动设置");
    }
    if (status !== undefined) {
      const room = scoped(await this.prisma.room.findUnique({ where: { id }, select: { status: true, isTest: true } }), request.currentUser, "直播间不存在");
      if (room.status === "LIVE") throw new BadRequestException("直播中请先停止 OBS，等待云回调更新状态");
    }
    return this.prisma.room.update({ where: { id }, data: {
      ...(title === undefined ? {} : { title }),
      ...(status === undefined ? {} : { status: status as "DRAFT" | "READY" | "LIVE" | "ENDED" })
    } });
  }

  @Get("rooms/:id/publish")
  async publishAddress(@Req() request: UserRequest, @Param("id") id: string) {
    requireStaff(request.currentUser);
    const room = await this.room(id, request);
    const domain = liveDomain();
    const expire = Math.floor(Date.now() / 1000) + 12 * 60 * 60;
    const token = publishToken(room.streamName, expire);
    return {
      url: `rtmp://${domain}:1935/live/${room.streamName}?token=${token}&expire=${expire}`,
      expiresAt: new Date(expire * 1000).toISOString()
    };
  }

  @Get("rooms/:id/playback")
  async playbackAddress(@Param("id") id: string, @Req() request: UserRequest) {
    const room = await this.room(id, request);
    const domain = liveDomain();
    return {
      status: room.status,
      flv: `https://${domain}/live/${room.streamName}.flv`,
      hls: `https://${domain}/live/${room.streamName}.m3u8`,
      expiresAt: new Date(Date.now() + 4 * 60 * 60 * 1000).toISOString()
    };
  }

  @Get("products")
  async products(@Req() request: UserRequest) {
    const staff = isAdminRole(request.currentUser.role) || request.currentUser.role === "TEACHER";
    const products = await this.prisma.product.findMany({
      where: { ...(staff ? {} : { isActive: true, rooms: { some: { room: { status: { not: "DRAFT" } } } } }), ...dataScope(request.currentUser) ?? {} }, orderBy: { createdAt: "desc" },
      include: { detailImages: { select: { imageKey: true }, orderBy: { position: "asc" } } }
    });
    return products.map((product) => this.withImage(product));
  }

  @Post("products")
  async createProduct(@Req() request: UserRequest, @Body() body: unknown) {
    requireStaff(request.currentUser);
    const input = object(body);
    const storeId = stringField(input, "storeId", 100);
    sameSideCreate(scoped(await this.prisma.store.findUnique({ where: { id: storeId } }), request.currentUser, "店铺不存在"), request.currentUser);
    const imageUrl = optionalString(input, "imageUrl", 500);
    const imageKey = optionalString(input, "imageKey", 200);
    const detailKeys = detailImageKeys(input);
    if (imageUrl && !imageUrl.startsWith("https://")) throw new BadRequestException("图片地址必须是 HTTPS");
    if (imageKey && !/^product-images\/[a-f0-9]{32}\.(jpg|png|webp)$/.test(imageKey)) {
      throw new BadRequestException("图片对象键不正确");
    }
    return this.prisma.product.create({ data: {
      storeId,
      name: stringField(input, "name", 100),
      isTest: isTestCreator(request.currentUser),
      description: optionalString(input, "description") ?? "",
      pointsPrice: integerField(input, "pointsPrice", 1, 1_000_000),
      pickupPoint: stringField(input, "pickupPoint", 200),
      imageUrl, imageKey,
      ...(detailKeys ? { detailImages: { create: detailKeys.map((imageKey, position) => ({ imageKey, position })) } } : {})
    }, include: { detailImages: { select: { imageKey: true }, orderBy: { position: "asc" } } } }).then((product) => this.withImage(product));
  }

  @Patch("products/:id")
  async updateProduct(@Req() request: UserRequest, @Param("id") id: string, @Body() body: unknown) {
    requireStaff(request.currentUser);
    const previous = scoped(await this.prisma.product.findUnique({ where: { id }, include: { detailImages: { select: { imageKey: true } } } }), request.currentUser, "商品不存在");
    const input = object(body);
    const name = optionalString(input, "name", 100);
    const description = optionalString(input, "description", 1000);
    const isActive = input.isActive;
    const imageKey = optionalString(input, "imageKey", 200);
    if (imageKey && !/^product-images\/[a-f0-9]{32}\.(jpg|png|webp)$/.test(imageKey)) throw new BadRequestException("图片对象键不正确");
    if (name !== undefined && !name) throw new BadRequestException("商品名称不能为空");
    if (isActive !== undefined && typeof isActive !== "boolean") throw new BadRequestException("上架状态不正确");
    const pointsPrice = input.pointsPrice === undefined ? undefined : integerField(input, "pointsPrice", 1, 1_000_000);
    const pickupPoint = input.pickupPoint === undefined ? undefined : stringField(input, "pickupPoint", 200);
    const detailKeys = detailImageKeys(input);
    const updated = await this.prisma.$transaction(async (tx) => {
      const product = await tx.product.update({
        where: { id }, data: { name, description, pointsPrice, pickupPoint, isActive: isActive as boolean | undefined,
          ...(imageKey === undefined ? {} : { imageKey: imageKey || null, imageUrl: null }) },
        include: { detailImages: { select: { imageKey: true }, orderBy: { position: "asc" } } }
      });
      if (detailKeys) {
        await tx.productDetailImage.deleteMany({ where: { productId: id } });
        if (detailKeys.length) {
          await tx.productDetailImage.createMany({ data: detailKeys.map((key, position) => ({ productId: id, imageKey: key, position })) });
        }
      }
      return product;
    });
    // 主图被替换或清空时删除旧对象；详情图整组替换时删除不再引用的旧对象（失败仅记日志）。
    if (imageKey !== undefined && previous.imageKey && imageKey !== previous.imageKey) await this.storage.deleteImage(previous.imageKey);
    if (detailKeys) {
      for (const item of previous.detailImages) {
        if (!detailKeys.includes(item.imageKey)) await this.storage.deleteImage(item.imageKey);
      }
    }
    return this.withImage(updated);
  }

  @Get("rooms/:id/products")
  async roomProducts(@Param("id") id: string, @Req() request: UserRequest) {
    await this.room(id, request);
    const bindings = await this.prisma.roomProduct.findMany({
      where: { roomId: id, ...(request.currentUser.role === "STUDENT" ? { product: { isActive: true } } : {}) },
      include: { product: { include: { detailImages: { select: { imageKey: true }, orderBy: { position: "asc" } } } } }, orderBy: { position: "asc" }
    });
    return bindings.map(({ product, position }) => ({ ...this.withImage(product), position }));
  }

  @Post("rooms/:id/products")
  async bindProduct(@Req() request: UserRequest, @Param("id") id: string, @Body() body: unknown) {
    requireStaff(request.currentUser);
    const input = object(body);
    const productId = stringField(input, "productId", 100);
    const [room, product] = await Promise.all([
      this.prisma.room.findUnique({ where: { id } }),
      this.prisma.product.findUnique({ where: { id: productId } })
    ]);
    if (!room || !product) throw new NotFoundException("直播间或商品不存在");
    scoped(room, request.currentUser, "直播间或商品不存在");
    scoped(product, request.currentUser, "直播间或商品不存在");
    assertSameSide(room, product);
    if (room.storeId !== product.storeId) throw new BadRequestException("商品不属于直播间店铺");
    const position = input.position === undefined ? 0 : integerField(input, "position", 0, 9999);
    const binding = await this.prisma.roomProduct.upsert({
      where: { roomId_productId: { roomId: id, productId } },
      update: { position }, create: { roomId: id, productId, position }
    });
    // 非准备中的课堂才实时推送（DRAFT 课堂对学生不可见，无需广播）
    if (room.status !== "DRAFT") {
      this.chat.broadcastRoomProducts(id, "bound", { id: product.id, name: product.name, pointsPrice: product.pointsPrice, isActive: product.isActive, position: binding.position });
    }
    return binding;
  }

  @Delete("rooms/:id/products/:productId")
  async unbindProduct(@Req() request: UserRequest, @Param("id") id: string, @Param("productId") productId: string) {
    requireStaff(request.currentUser);
    const room = visibleRoom(await this.prisma.room.findUnique({ where: { id }, select: { status: true, isTest: true } }), request.currentUser);
    const result = await this.prisma.roomProduct.deleteMany({ where: { roomId: id, productId } });
    if (result.count && room.status !== "DRAFT") {
      const product = await this.prisma.product.findUnique({ where: { id: productId }, select: { id: true, name: true, pointsPrice: true, isActive: true } });
      if (product) this.chat.broadcastRoomProducts(id, "unbound", { ...product, position: 0 });
    }
    return result;
  }

  @Get("cart")
  async cart(@Req() request: UserRequest) {
    const items = await this.prisma.cartItem.findMany({
      where: { userId: request.currentUser.id }, include: { product: { include: { rooms: { select: { roomId: true } }, detailImages: { select: { imageKey: true }, orderBy: { position: "asc" } } } } }
    });
    return items.map((item) => ({ ...item, product: { ...this.withImage(item.product), roomIds: item.product.rooms.map((room) => room.roomId) } }));
  }

  @Post("cart")
  async addToCart(@Req() request: UserRequest, @Body() body: unknown) {
    const input = object(body);
    const productId = stringField(input, "productId", 100);
    const userId = request.currentUser.id;
    return withUserLock(this.prisma, userId, async (tx) => {
      const product = await tx.product.findUnique({ where: { id: productId } });
      if (!product?.isActive) throw new NotFoundException("商品不存在或已下架");
      scoped(product, request.currentUser, "商品不存在或已下架");
      if (!(await tx.roomProduct.findFirst({ where: { productId, ...(request.currentUser.role === "STUDENT" ? { room: { status: { not: "DRAFT" } } } : {}) }, select: { roomId: true } }))) {
        throw new BadRequestException("商品尚未绑定直播间");
      }
      const where = { userId_productId: { userId, productId } };
      const item = await tx.cartItem.findUnique({ where });
      if (item && item.quantity >= 99) throw new BadRequestException("每件商品最多 99 件");
      return tx.cartItem.upsert({ where, update: { quantity: { increment: 1 } }, create: { userId, productId } });
    });
  }

  @Patch("cart/:productId")
  async updateCart(@Req() request: UserRequest, @Param("productId") productId: string, @Body() body: unknown) {
    const quantity = integerField(object(body), "quantity", 1, 99);
    const userId = request.currentUser.id;
    return withUserLock(this.prisma, userId, async (tx) => {
      const result = await tx.cartItem.updateMany({ where: { userId, productId, product: { isActive: true } }, data: { quantity } });
      if (!result.count) throw new NotFoundException("购物车商品不存在或已下架");
      return { ok: true };
    });
  }

  @Delete("cart/:productId")
  removeFromCart(@Req() request: UserRequest, @Param("productId") productId: string) {
    const userId = request.currentUser.id;
    return withUserLock(this.prisma, userId, (tx) => tx.cartItem.deleteMany({ where: { userId, productId } }));
  }
}
