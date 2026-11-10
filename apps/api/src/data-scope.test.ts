import "reflect-metadata";
import test from "node:test";
import assert from "node:assert/strict";
import { BusinessController } from "./business.controller.js";
import { CommerceController } from "./commerce.controller.js";
import { StorageService } from "./storage.service.js";
import { visibleRoom } from "./room-access.js";
import { scoped, sameSideCreate, isTestCreator } from "./data-scope.js";
import type { PrismaService } from "./prisma.service.js";
import type { UserRequest } from "./auth.guard.js";
import type { CurrentUser } from "./auth.service.js";
import { AuditService } from "./audit.service.js";
const audit = { log: async () => undefined } as unknown as AuditService;

const superAdmin = { currentUser: { id: "root-1", role: "SUPER_ADMIN", isTest: false, displayName: "超级管理员" } as CurrentUser } as UserRequest;
const admin = { currentUser: { id: "admin-1", role: "ADMIN", isTest: false, displayName: "管理员" } as CurrentUser } as UserRequest;
const student = { currentUser: { id: "student-1", role: "STUDENT", isTest: false, displayName: "学生" } as CurrentUser } as UserRequest;
const testStudent = { currentUser: { id: "test-student-1", role: "STUDENT", isTest: true, displayName: "测试学生" } as CurrentUser } as UserRequest;
const teacher = { currentUser: { id: "teacher-1", role: "TEACHER", isTest: false, displayName: "教师" } as CurrentUser } as UserRequest;
const testTeacher = { currentUser: { id: "test-teacher-1", role: "TEACHER", isTest: true, displayName: "测试教师" } as CurrentUser } as UserRequest;

test("课堂单条访问按数据侧隔离：正式、测试、超管三视角", () => {
  const testRoom = { id: "r1", status: "READY", isTest: true };
  const prodRoom = { id: "r2", status: "READY", isTest: false };
  // 正式侧用户看不见测试课堂
  assert.throws(() => visibleRoom(testRoom, student.currentUser), /直播间不存在/);
  assert.throws(() => visibleRoom(testRoom, admin.currentUser), /直播间不存在/);
  // 测试侧用户看不见正式课堂，但看得见测试课堂
  assert.throws(() => visibleRoom(prodRoom, testStudent.currentUser), /直播间不存在/);
  assert.equal(visibleRoom(testRoom, testStudent.currentUser), testRoom);
  // 超级管理员两侧都放行
  assert.equal(visibleRoom(testRoom, superAdmin.currentUser), testRoom);
  assert.equal(visibleRoom(prodRoom, superAdmin.currentUser), prodRoom);
});

test("scoped 与 sameSideCreate：跨侧一律拒绝，超管创建只能落在测试侧", () => {
  const testStore = { id: "s1", isTest: true };
  const prodStore = { id: "s2", isTest: false };
  assert.throws(() => scoped(testStore, admin.currentUser, "店铺不存在"), /店铺不存在/);
  assert.equal(scoped(prodStore, admin.currentUser, "店铺不存在"), prodStore);
  assert.equal(scoped(testStore, superAdmin.currentUser, "店铺不存在"), testStore);
  // 超管创建的是测试数据，只能挂测试店铺；普通员工只能挂正式店铺
  assert.throws(() => sameSideCreate(prodStore, superAdmin.currentUser), /测试数据需创建在测试店铺下/);
  assert.equal(sameSideCreate(testStore, superAdmin.currentUser), true);
  assert.throws(() => sameSideCreate(testStore, admin.currentUser), /正式数据不能创建在测试店铺下/);
  assert.equal(isTestCreator(admin.currentUser), false);
});

test("列表查询只返回同侧数据，超管返回全部", async () => {
  const queries: { where: Record<string, unknown> }[] = [];
  const prisma = {
    store: {
      findMany: async ({ where }: { where: Record<string, unknown> }) => { queries.push({ where }); return []; },
      findUnique: async () => null
    }
  } as unknown as PrismaService;
  const business = new BusinessController(prisma, new StorageService({} as never, {} as never), audit);
  await business.stores(admin);
  await business.stores(testStudent);
  await business.stores(superAdmin);
  assert.deepEqual(queries[0]?.where, { isTest: false });
  assert.deepEqual(queries[1]?.where, { isTest: true });
  assert.equal(queries[2]?.where, undefined);
});

test("正式学生不能领取测试优惠券，测试学生可以", async () => {
  const coupon = { id: "c1", expiresAt: new Date(Date.now() + 60_000), isTest: true, room: { id: "r1", status: "READY", isTest: true } };
  const prisma = {
    coupon: {
      findUnique: async () => coupon
    },
    userCoupon: {
      upsert: async () => ({ ok: true })
    }
  } as unknown as PrismaService;
  const commerce = new CommerceController(prisma, audit);
  await assert.rejects(commerce.claimCoupon(student, "c1"), /优惠券不存在或已过期/);
  await commerce.claimCoupon(testStudent, "c1");
});

test("超管创建的账号与店铺自动进入测试侧，管理员创建的留在正式侧", async () => {
  const created: { isTest?: boolean }[] = [];
  const prisma = {
    user: {
      findUnique: async () => null,
      create: async ({ data }: { data: { isTest?: boolean } }) => { created.push(data); return data; }
    },
    store: {
      findMany: async () => [],
      create: async ({ data }: { data: { isTest?: boolean } }) => { created.push(data); return data; }
    }
  } as unknown as PrismaService;
  const business = new BusinessController(prisma, new StorageService({} as never, {} as never), audit);
  await business.createUser(superAdmin, { email: "probe@student.test", password: "123456", role: "STUDENT" });
  await business.createStore(superAdmin, { name: "测试店铺" });
  await business.createStore(admin, { name: "正式店铺" });
  assert.deepEqual(created.map((item) => item.isTest), [true, true, false]);
});

test("管理侧订单接口按请求者数据侧过滤，超管返回全部", async () => {
  const orderWheres: Record<string, unknown>[] = [];
  const countWheres: Record<string, unknown>[] = [];
  const prisma = {
    $transaction: async (ops: Promise<unknown>[]) => Promise.all(ops),
    order: {
      findMany: async ({ where }: { where: Record<string, unknown> }) => { orderWheres.push(where); return []; },
      count: async ({ where }: { where: Record<string, unknown> }) => { countWheres.push(where); return 0; }
    }
  } as unknown as PrismaService;
  const commerce = new CommerceController(prisma, audit);
  await commerce.staffOrders(teacher, {});
  await commerce.staffOrders(testTeacher, { q: "小明" });
  await commerce.staffOrders(superAdmin, {});
  assert.deepEqual(orderWheres[0], { user: { isTest: false } });
  assert.deepEqual(orderWheres[1], { user: { isTest: true }, OR: [{ id: { contains: "小明" } }, { user: { email: { contains: "小明" } } }, { user: { displayName: { contains: "小明" } } }, { items: { some: { name: { contains: "小明" } } } }] });
  assert.deepEqual(orderWheres[2], {});
  await commerce.staffOverview(teacher);
  await commerce.staffOverview(superAdmin);
  assert.deepEqual(countWheres.at(-2), { status: { in: ["PENDING_PICKUP", "PENDING_DELIVERY"] }, user: { isTest: false } });
  assert.deepEqual(countWheres.at(-1), { status: { in: ["PENDING_PICKUP", "PENDING_DELIVERY"] } });
});

test("标记订单完成前先做同侧校验，跨侧订单拒绝", async () => {
  const testOrder = { id: "o1", status: "PENDING_PICKUP", user: { isTest: true } };
  let updated = false;
  const prisma = {
    order: {
      findUnique: async () => testOrder,
      update: async () => { updated = true; return {}; }
    }
  } as unknown as PrismaService;
  const commerce = new CommerceController(prisma, audit);
  await assert.rejects(commerce.completeOrder(teacher, "o1"), /订单不存在或已完成/);
  assert.equal(updated, false);
  await commerce.completeOrder(superAdmin, "o1");
  assert.equal(updated, true);
});
