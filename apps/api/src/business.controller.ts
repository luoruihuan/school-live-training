import { randomBytes } from "node:crypto";
import { BadRequestException, Body, Controller, Delete, ForbiddenException, Get, NotFoundException, Param, Patch, Post, Query, Req, Res, ServiceUnavailableException, UseGuards } from "@nestjs/common";
import type { Request, Response } from "express";
import type { UserRequest } from "./auth.guard.js";
import { AuthGuard, requireStaff } from "./auth.guard.js";
import { hashPassword } from "./auth.service.js";
import { integerField, object, optionalString, stringField } from "./input.js";
import { PrismaService } from "./prisma.service.js";
import { StorageService } from "./storage.service.js";
import type { Product } from "./generated/prisma/client.js";
import { withUserLock } from "./user-transaction.js";
import { visibleRoom } from "./room-access.js";
import { publishToken } from "./cloud-webhook.controller.js";

function liveDomain(): string {
  const value = process.env.APP_DOMAIN;
  if (!value || value.includes("example.com")) throw new ServiceUnavailableException("请先配置 APP_DOMAIN");
  return value;
}

@Controller()
@UseGuards(AuthGuard)
export class BusinessController {
  constructor(private readonly prisma: PrismaService, private readonly storage: StorageService) {}

  private async withImage(product: Product): Promise<Product> {
    if (!product.imageKey) return product;
    return { ...product, imageUrl: `/api/product-images/${product.id}` };
  }

  @Post("users")
  async createUser(@Req() request: UserRequest, @Body() body: unknown) {
    if (request.currentUser.role !== "ADMIN") throw new ForbiddenException("仅管理员可创建账号");
    const input = object(body);
    const email = stringField(input, "email", 100).toLowerCase();
    const password = stringField(input, "password", 200);
    if (!/^[a-zA-Z0-9._@-]{2,100}$/.test(email)) throw new BadRequestException("账号仅支持字母、数字、点、下划线、@、中划线");
    if (password.length < 6) throw new BadRequestException("初始密码至少 6 位");
    const role = input.role;
    if (role !== "TEACHER" && role !== "STUDENT") throw new BadRequestException("角色不正确");
    if (await this.prisma.user.findUnique({ where: { email } })) throw new BadRequestException("该账号已存在");
    return this.prisma.user.create({
      data: { email, displayName: optionalString(input, "displayName", 80) || email, passwordHash: await hashPassword(password), role, mustChangePassword: true },
      select: { id: true, email: true, displayName: true, role: true, createdAt: true }
    });
  }

  @Get("product-images/:id")
  async productImage(@Req() request: UserRequest, @Param("id") id: string, @Res() response: Response) {
    void request;
    const product = await this.prisma.product.findUnique({ where: { id } });
    if (!product?.imageKey) throw new NotFoundException("商品图片不存在");
    const { stream, contentType } = await this.storage.getImageStream(product.imageKey);
    response.status(200);
    response.setHeader("Content-Type", contentType);
    response.setHeader("Cache-Control", "private, max-age=86400");
    stream.pipe(response);
  }

  @Get("stores")
  stores() {
    return this.prisma.store.findMany({ orderBy: { createdAt: "desc" } });
  }

  @Post("stores")
  createStore(@Req() request: UserRequest, @Body() body: unknown) {
    requireStaff(request.currentUser);
    const input = object(body);
    return this.prisma.store.create({
      data: { name: stringField(input, "name", 80), description: optionalString(input, "description") ?? "" }
    });
  }

  @Get("rooms")
  async rooms(@Req() request: UserRequest) {
    const rooms = await this.prisma.room.findMany({ where: request.currentUser.role === "STUDENT" ? { status: { not: "DRAFT" } } : {}, include: {
      store: { select: { id: true, name: true } },
      _count: { select: { products: { where: { product: { isActive: true } } }, coupons: { where: { expiresAt: { gt: new Date() } } }, recordings: { where: { expiresAt: { gt: new Date() }, objectKey: { endsWith: ".mp4" } } } } }
    }, orderBy: { createdAt: "desc" } });
    return rooms.map(({ _count, ...room }) => ({ ...room, productCount: _count.products, couponCount: _count.coupons, recordingCount: _count.recordings }));
  }

  @Patch("stores/:id")
  async updateStore(@Req() request: UserRequest, @Param("id") id: string, @Body() body: unknown) {
    requireStaff(request.currentUser);
    const input = object(body);
    if (!(await this.prisma.store.findUnique({ where: { id } }))) throw new NotFoundException("店铺不存在");
    return this.prisma.store.update({ where: { id }, data: {
      name: stringField(input, "name", 80), description: optionalString(input, "description") ?? ""
    } });
  }

  @Get("rooms/:id")
  async room(@Param("id") id: string, @Req() request: UserRequest) {
    const room = await this.prisma.room.findUnique({ where: { id }, include: { store: true } });
    return visibleRoom(room, request.currentUser.role);
  }

  @Post("rooms")
  async createRoom(@Req() request: UserRequest, @Body() body: unknown) {
    requireStaff(request.currentUser);
    const input = object(body);
    const storeId = stringField(input, "storeId", 100);
    if (!(await this.prisma.store.findUnique({ where: { id: storeId } }))) throw new NotFoundException("店铺不存在");
    return this.prisma.room.create({
      data: { storeId, title: stringField(input, "title", 100), streamName: randomBytes(12).toString("hex") }
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
      const room = await this.prisma.room.findUnique({ where: { id }, select: { status: true } });
      if (!room) throw new NotFoundException("直播间不存在");
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
      flv: `https://${domain}/live/${room.streamName}.flv`,
      hls: `https://${domain}/live/${room.streamName}.m3u8`,
      expiresAt: new Date(Date.now() + 4 * 60 * 60 * 1000).toISOString()
    };
  }

  @Get("products")
  async products(@Req() request: UserRequest) {
    const staff = request.currentUser.role === "ADMIN" || request.currentUser.role === "TEACHER";
    const products = await this.prisma.product.findMany({
      where: staff ? {} : { isActive: true, rooms: { some: { room: { status: { not: "DRAFT" } } } } }, orderBy: { createdAt: "desc" }
    });
    return Promise.all(products.map((product) => this.withImage(product)));
  }

  @Post("products")
  async createProduct(@Req() request: UserRequest, @Body() body: unknown) {
    requireStaff(request.currentUser);
    const input = object(body);
    const storeId = stringField(input, "storeId", 100);
    if (!(await this.prisma.store.findUnique({ where: { id: storeId } }))) throw new NotFoundException("店铺不存在");
    const imageUrl = optionalString(input, "imageUrl", 500);
    const imageKey = optionalString(input, "imageKey", 200);
    if (imageUrl && !imageUrl.startsWith("https://")) throw new BadRequestException("图片地址必须是 HTTPS");
    if (imageKey && !/^product-images\/[a-f0-9]{32}\.(jpg|png|webp)$/.test(imageKey)) {
      throw new BadRequestException("图片对象键不正确");
    }
    return this.prisma.product.create({ data: {
      storeId,
      name: stringField(input, "name", 100),
      description: optionalString(input, "description") ?? "",
      pointsPrice: integerField(input, "pointsPrice", 1, 1_000_000),
      pickupPoint: stringField(input, "pickupPoint", 200),
      imageUrl, imageKey
    } });
  }

  @Patch("products/:id")
  async updateProduct(@Req() request: UserRequest, @Param("id") id: string, @Body() body: unknown) {
    requireStaff(request.currentUser);
    if (!(await this.prisma.product.findUnique({ where: { id } }))) throw new NotFoundException("商品不存在");
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
    return this.prisma.product.update({
      where: { id }, data: { name, description, pointsPrice, pickupPoint, isActive: isActive as boolean | undefined,
        ...(imageKey === undefined ? {} : { imageKey: imageKey || null, imageUrl: null }) }
    });
  }

  @Get("rooms/:id/products")
  async roomProducts(@Param("id") id: string, @Req() request: UserRequest) {
    await this.room(id, request);
    const bindings = await this.prisma.roomProduct.findMany({
      where: { roomId: id, ...(request.currentUser.role === "STUDENT" ? { product: { isActive: true } } : {}) },
      include: { product: true }, orderBy: { position: "asc" }
    });
    return Promise.all(bindings.map(async ({ product, position }) => ({ ...await this.withImage(product), position })));
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
    if (room.storeId !== product.storeId) throw new BadRequestException("商品不属于直播间店铺");
    const position = input.position === undefined ? 0 : integerField(input, "position", 0, 9999);
    return this.prisma.roomProduct.upsert({
      where: { roomId_productId: { roomId: id, productId } },
      update: { position }, create: { roomId: id, productId, position }
    });
  }

  @Delete("rooms/:id/products/:productId")
  unbindProduct(@Req() request: UserRequest, @Param("id") id: string, @Param("productId") productId: string) {
    requireStaff(request.currentUser);
    return this.prisma.roomProduct.deleteMany({ where: { roomId: id, productId } });
  }

  @Get("cart")
  async cart(@Req() request: UserRequest) {
    const items = await this.prisma.cartItem.findMany({
      where: { userId: request.currentUser.id }, include: { product: { include: { rooms: { select: { roomId: true } } } } }
    });
    return Promise.all(items.map(async (item) => ({ ...item, product: { ...await this.withImage(item.product), roomIds: item.product.rooms.map((room) => room.roomId) } })));
  }

  @Post("cart")
  async addToCart(@Req() request: UserRequest, @Body() body: unknown) {
    const input = object(body);
    const productId = stringField(input, "productId", 100);
    const userId = request.currentUser.id;
    return withUserLock(this.prisma, userId, async (tx) => {
      const product = await tx.product.findUnique({ where: { id: productId } });
      if (!product?.isActive) throw new NotFoundException("商品不存在或已下架");
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
