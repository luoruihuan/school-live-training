import "reflect-metadata";
import "dotenv/config";
import test from "node:test";
import assert from "node:assert/strict";
import { PrismaService } from "./prisma.service.js";
import { BusinessController } from "./business.controller.js";
import { CommerceController } from "./commerce.controller.js";
import { AccountController } from "./account.controller.js";
import { AuthService, hashPassword } from "./auth.service.js";
import { StorageService } from "./storage.service.js";
import type { UserRequest } from "./auth.guard.js";
import { ChatGateway } from "./chat.gateway.js";

test("真实数据库：结算并发、数量边界、账号生命周期和角色权限", { skip: process.env.RUN_DB_TESTS !== "true" }, async (t) => {
  const db = new PrismaService();
  const suffix = crypto.randomUUID();
  const student = await db.user.create({ data: { email: `verify-${suffix}@example.local`, displayName: "自动验证账号", passwordHash: await hashPassword("Verification123!"), role: "STUDENT" } });
  const adminUser = await db.user.create({ data: { email: `admin-${suffix}@example.local`, displayName: "验证管理员", passwordHash: await hashPassword("AdminVerification123!"), role: "ADMIN" } });
  const store = await db.store.create({ data: { name: `验证店铺-${suffix}` } });
  let createdUserId: string | undefined;
  t.after(async () => {
    await db.pointLedger.deleteMany({ where: { userId: student.id } });
    await db.order.deleteMany({ where: { userId: student.id } });
    await db.user.delete({ where: { id: student.id } });
    await db.user.delete({ where: { id: adminUser.id } });
    if (createdUserId) await db.user.delete({ where: { id: createdUserId } });
    await db.store.delete({ where: { id: store.id } });
    await db.$disconnect();
  });
  const room = await db.room.create({ data: { storeId: store.id, title: "验证直播间", streamName: `verify-${suffix}`, status: "READY" } });
  const product = await db.product.create({ data: { storeId: store.id, name: "验证商品", pointsPrice: 100, pickupPoint: "教学楼一层" } });
  await db.roomProduct.create({ data: { roomId: room.id, productId: product.id } });
  const request = { currentUser: student } as unknown as UserRequest;
  const admin = { currentUser: adminUser } as unknown as UserRequest;
  const teacher = { currentUser: { id: "test-teacher", role: "TEACHER" } } as UserRequest;
  const business = new BusinessController(db, new StorageService({} as never));
  const commerce = new CommerceController(db);
  const auth = new AuthService(db);
  const accounts = new AccountController(db, new ChatGateway(auth, db));

  await t.test("学生不能通过商品列表或购物车进入草稿课堂", async () => {
    await db.room.update({ where: { id: room.id }, data: { status: "DRAFT" } });
    assert.equal((await business.rooms(request)).length, 0);
    assert.equal((await business.products(request)).length, 0);
    await assert.rejects(business.addToCart(request, { productId: product.id }), /尚未绑定直播间/);
    await db.room.update({ where: { id: room.id }, data: { status: "READY" } });
  });

  await t.test("管理员创建账号后首次登录必须改密", async () => {
    const created = await business.createUser(admin, { email: `first-${suffix}@example.local`, displayName: "首次登录验证", role: "STUDENT", password: "InitialVerification123!" });
    createdUserId = created.id;
    const login = await auth.login(created.email, "InitialVerification123!");
    assert.equal(login.user.mustChangePassword, true);
  });

  await t.test("管理员充值有流水，同一请求不会重复充值", async () => {
    const key = crypto.randomUUID();
    await Promise.all(Array.from({ length: 5 }, () => accounts.topup(admin, student.id, { points: 300, requestKey: key, adminPassword: "AdminVerification123!" })));
    await accounts.topup(admin, student.id, { points: 300, requestKey: key, adminPassword: "AdminVerification123!" });
    await assert.rejects(accounts.topup(request, student.id, { points: 300, requestKey: crypto.randomUUID(), adminPassword: "AdminVerification123!" }), /仅管理员/);
    await assert.rejects(accounts.topup(admin, student.id, { points: 301, requestKey: key, adminPassword: "AdminVerification123!" }), /提交标识/);
    assert.equal((await db.user.findUniqueOrThrow({ where: { id: student.id } })).pointsBalance, 300);
    const entries = await db.pointLedger.findMany({ where: { userId: student.id } });
    assert.equal(entries.length, 1);
    assert.equal(entries[0]!.actorId, adminUser.id);
    assert.equal(entries[0]!.balanceAfter, 300);
  });

  await t.test("管理员可扣减和设置积分，重复请求不重扣且不能扣成负数", async () => {
    const deductKey = crypto.randomUUID();
    await accounts.topup(admin, student.id, { mode: "DEDUCT", points: 50, reason: "纠正发放", requestKey: deductKey, adminPassword: "AdminVerification123!" });
    await accounts.topup(admin, student.id, { mode: "DEDUCT", points: 50, reason: "纠正发放", requestKey: deductKey, adminPassword: "AdminVerification123!" });
    assert.equal((await db.user.findUniqueOrThrow({ where: { id: student.id } })).pointsBalance, 250);
    await assert.rejects(accounts.topup(admin, student.id, { mode: "DEDUCT", points: 251, reason: "测试", requestKey: crypto.randomUUID(), adminPassword: "AdminVerification123!" }), /积分不足/);
    await accounts.topup(admin, student.id, { mode: "SET", points: 300, reason: "期初调整", requestKey: crypto.randomUUID(), adminPassword: "AdminVerification123!" });
    assert.equal((await db.user.findUniqueOrThrow({ where: { id: student.id } })).pointsBalance, 300);
    const ledger = await accounts.pointHistory(admin, student.id, {});
    assert.equal(ledger.items[0]!.balanceAfter, 300);
    assert.equal(ledger.items[1]!.delta, -50);
    assert.throws(() => accounts.pointHistory(teacher, student.id, {}), /仅管理员/);
  });

  await t.test("数量修改和上下限", async () => {
    await business.addToCart(request, { productId: product.id });
    await business.updateCart(request, product.id, { quantity: 99 });
    await assert.rejects(business.addToCart(request, { productId: product.id }), /99/);
    await assert.rejects(business.updateCart(request, product.id, { quantity: 0 }));
    await business.updateCart(request, product.id, { quantity: 2 });
  });
  await t.test("并发重试只生成一份订单；不同提交不能重复消费购物车", async () => {
    const requestKey = crypto.randomUUID();
    const results = await Promise.all(Array.from({ length: 5 }, () => commerce.createOrder(request, { requestKey, expectedPointsTotal: 200 })));
    assert.equal(new Set(results.map((r) => r.id)).size, 1);
    assert.equal(results[0]!.pointsTotal, 200);
    assert.equal(results[0]!.fulfillmentMethod, "PICKUP");
    assert.equal(results[0]!.items[0]!.pickupPoint, "教学楼一层");
    assert.equal((await db.user.findUniqueOrThrow({ where: { id: student.id } })).pointsBalance, 100);
    assert.equal(await db.order.count({ where: { userId: student.id } }), 1);
    await assert.rejects(commerce.createOrder(request, { requestKey, expectedPointsTotal: 201 }), /提交标识/);
    await business.addToCart(request, { productId: product.id });
    await assert.rejects(commerce.createOrder(request, { requestKey: crypto.randomUUID(), expectedPointsTotal: 100, fulfillmentMethod: "DELIVERY" }), /送货地点/);
    await commerce.createOrder(request, { requestKey: crypto.randomUUID(), expectedPointsTotal: 100, fulfillmentMethod: "DELIVERY", deliveryAddress: "宿舍楼门口" });
    assert.equal((await db.user.findUniqueOrThrow({ where: { id: student.id } })).pointsBalance, 0);
  });
  await t.test("直播间优惠券只抵扣适用商品，积分不足时不生成订单", async () => {
    const coupon = await commerce.createCoupon(admin, { storeId: store.id, roomId: room.id, name: "实训优惠", pointsDiscount: 30, expiresAt: new Date(Date.now() + 86_400_000).toISOString() });
    await commerce.claimCoupon(request, coupon.id);
    await business.addToCart(request, { productId: product.id });
    await assert.rejects(commerce.createOrder(request, { requestKey: crypto.randomUUID(), expectedPointsTotal: 70, couponId: coupon.id }), /积分不足/);
    await accounts.topup(admin, student.id, { points: 70, requestKey: crypto.randomUUID(), adminPassword: "AdminVerification123!" });
    const order = await commerce.createOrder(request, { requestKey: crypto.randomUUID(), expectedPointsTotal: 70, couponId: coupon.id });
    assert.equal(order.pointsDiscount, 30);
    assert.equal(order.pointsTotal, 70);
    assert.equal((await db.user.findUniqueOrThrow({ where: { id: student.id } })).pointsBalance, 0);
  });
  await t.test("商品积分变动时拒绝按旧价格兑换", async () => {
    await business.addToCart(request, { productId: product.id });
    await db.product.update({ where: { id: product.id }, data: { pointsPrice: 120 } });
    await assert.rejects(commerce.createOrder(request, { requestKey: crypto.randomUUID(), expectedPointsTotal: 100 }), /积分已变化/);
    await business.removeFromCart(request, product.id);
  });
  await t.test("账号列表和全校订单只向授权角色开放", async () => {
    assert.throws(() => accounts.list(teacher), /仅管理员/);
    await assert.rejects(commerce.staffOrders(request, {}), /仅教师/);
    const result = await commerce.staffOrders(teacher, { q: student.email });
    assert.equal(result.total, 3);
    assert.ok(result.items.every((order) => order.user.id === student.id));
    const mine = await commerce.orders(request, { page: 1 });
    assert.equal(mine.total, 3);
    assert.ok(mine.items.every((order) => order.userId === student.id));
    await assert.rejects(commerce.orders(request, { page: 0 }), /页码不正确/);
    assert.ok((await accounts.list(admin)).every((user) => !("passwordHash" in user)));
  });
  await t.test("重置密码和停用使已签发会话失效", async () => {
    const first = await auth.login(student.email, "Verification123!");
    await accounts.reset(admin, student.id, { password: "NewVerification123!" });
    await assert.rejects(auth.userForToken(first.token));
    await assert.rejects(auth.login(student.email, "Verification123!"));
    const second = await auth.login(student.email, "NewVerification123!");
    assert.equal(second.user.mustChangePassword, true);
    await auth.changePassword(second.token, "NewVerification123!", "FinalVerification123!");
    await assert.rejects(auth.userForToken(second.token));
    const third = await auth.login(student.email, "FinalVerification123!");
    assert.equal(third.user.mustChangePassword, false);
    await accounts.update(admin, student.id, { isActive: false });
    await assert.rejects(auth.userForToken(third.token));
    await assert.rejects(auth.login(student.email, "FinalVerification123!"));
    await accounts.update(admin, student.id, { isActive: true });
    assert.ok((await auth.login(student.email, "FinalVerification123!")).token);
  });
});
