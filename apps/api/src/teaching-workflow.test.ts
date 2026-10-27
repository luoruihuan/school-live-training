import "reflect-metadata";
import test from "node:test";
import assert from "node:assert/strict";
import { BusinessController } from "./business.controller.js";
import { CommerceController } from "./commerce.controller.js";
import { StorageService } from "./storage.service.js";
import type { PrismaService } from "./prisma.service.js";
import type { UserRequest } from "./auth.guard.js";
import { AuditService } from "./audit.service.js";
const audit = { log: async () => undefined } as unknown as AuditService;

const teacher = { currentUser: { role: "TEACHER" } } as UserRequest;
const student = { currentUser: { role: "STUDENT" } } as UserRequest;

test("课堂列表返回商品、优惠券和可观看回放数", async () => {
  let query: { include: { _count: { select: { products: { where: { product: { isActive: boolean } } }; recordings: { where: { objectKey: { endsWith: string } } } } } } } | undefined;
  const prisma = { room: { findMany: async (args: typeof query) => { query = args; return [{ id: "room-1", title: "实训课", store: { id: "store-1", name: "实训店" }, _count: { products: 2, coupons: 1, recordings: 3 } }]; } } } as unknown as PrismaService;
  const rooms = await new BusinessController(prisma, new StorageService({} as never), audit).rooms(teacher);
  assert.equal(rooms[0]?.productCount, 2);
  assert.equal(rooms[0]?.couponCount, 1);
  assert.equal(rooms[0]?.recordingCount, 3);
  assert.equal("_count" in rooms[0]!, false);
  assert.equal(query?.include._count.select.products.where.product.isActive, true);
  assert.equal(query?.include._count.select.recordings.where.objectKey.endsWith, ".mp4");
});

test("教师不能手动把课堂标为直播中", async () => {
  let saved = false;
  const prisma = { room: { update: async () => { saved = true; } } } as unknown as PrismaService;
  await assert.rejects(new BusinessController(prisma, new StorageService({} as never), audit).updateRoom(teacher, "room-1", { status: "LIVE" }), /云推流回调/);
  assert.equal(saved, false);
});

test("直播中不能靠改页面状态关播，但可以修改标题", async () => {
  const saved: unknown[] = [];
  const prisma = { room: { findUnique: async () => ({ status: "LIVE" }), update: async (input: unknown) => { saved.push(input); return input; } } } as unknown as PrismaService;
  const business = new BusinessController(prisma, new StorageService({} as never), audit);
  await assert.rejects(business.updateRoom(teacher, "room-1", { status: "ENDED" }), /先停止 OBS/);
  await business.updateRoom(teacher, "room-1", { title: "新课堂标题" });
  assert.equal(saved.length, 1);
});

test("教师可停用优惠券，学生不能停用；待交付订单汇总只向教师开放", async () => {
  let expired = false;
  const prisma = {
    coupon: { updateMany: async () => { expired = true; return { count: 1 }; } },
    order: { count: async () => 2 }
  } as unknown as PrismaService;
  const commerce = new CommerceController(prisma, audit);
  await assert.rejects(commerce.expireCoupon(student, "coupon-1"), /仅教师/);
  assert.equal(expired, false);
  assert.deepEqual(await commerce.expireCoupon(teacher, "coupon-1"), { expired: true });
  assert.deepEqual(await commerce.staffOverview(teacher), { pendingOrders: 2 });
  await assert.rejects(commerce.staffOverview(student), /仅教师/);
});
