import "reflect-metadata";
import test from "node:test";
import assert from "node:assert/strict";
import type { NextFunction, Request, Response } from "express";
import { csrfProtection } from "./request-security.js";
import { BusinessController } from "./business.controller.js";
import { RecordingController } from "./recording.controller.js";
import { CommerceController } from "./commerce.controller.js";
import { StorageService } from "./storage.service.js";
import { HealthController } from "./health.controller.js";
import type { PrismaService } from "./prisma.service.js";
import type { UserRequest } from "./auth.guard.js";

const student = { currentUser: { id: "student-1", role: "STUDENT" } } as UserRequest;
const teacher = { currentUser: { id: "teacher-1", role: "TEACHER" } } as UserRequest;

test("草稿课堂在服务端不能被学生列表、观看、回放和领券访问", async () => {
  const room = { id: "draft-1", status: "DRAFT", streamName: "stream-1", store: { id: "store-1" } };
  const prisma = {
    room: {
      findMany: async ({ where }: { where: { status?: unknown } }) => where.status ? [] : [{ ...room, _count: { products: 0, coupons: 1, recordings: 1 } }],
      findUnique: async () => room
    },
    recording: { findUnique: async () => ({ id: "recording-1", roomId: room.id, expiresAt: new Date(Date.now() + 60_000), objectKey: "a.mp4" }) },
    coupon: { findUnique: async () => ({ id: "coupon-1", room, expiresAt: new Date(Date.now() + 60_000) }) },
    userCoupon: { upsert: async () => { throw new Error("不应领券"); } }
  } as unknown as PrismaService;
  const business = new BusinessController(prisma, new StorageService({} as never));
  assert.deepEqual(await business.rooms(student), []);
  assert.equal((await business.rooms(teacher)).length, 1);
  await assert.rejects(business.room(room.id, student), /直播间不存在/);
  await assert.rejects(business.playbackAddress(room.id, student), /直播间不存在/);
  await assert.rejects(new RecordingController(prisma, new StorageService({} as never)).playback("recording-1", student), /直播间不存在/);
  await assert.rejects(new CommerceController(prisma).claimCoupon(student, "coupon-1"), /直播间不存在/);
});

test("播放签名与腾讯云 1 秒 Key 有效时间合计为四小时", async (t) => {
  const previous = process.env;
  t.after(() => { process.env = previous; });
  process.env = { ...previous, APP_DOMAIN: "live.school.test" };
  const prisma = {
    room: { findUnique: async () => ({ id: "room-1", status: "READY", streamName: "stream-1" }) },
    serviceQuota: { findUnique: async () => ({ id: 1, startDate: new Date(Date.now() + 8 * 60 * 60 * 1000).toISOString().slice(0, 10), annualGb: 10000 }) },
    usageDaily: { findMany: async () => [] }
  } as unknown as PrismaService;
  const before = Date.now();
  const result = await new BusinessController(prisma, new StorageService({} as never)).playbackAddress("room-1", student);
  const after = Date.now();
  assert.equal(result.flv, "https://live.school.test/live/stream-1.flv");
  assert.equal(result.hls, "https://live.school.test/live/stream-1.m3u8");
  assert.ok(new Date(result.expiresAt).getTime() >= before + 240 * 60_000 - 1000);
  assert.ok(new Date(result.expiresAt).getTime() <= after + 240 * 60_000);
});

test("跨站写请求无法用表单或伪造来源触发，云回调保留独立入口", () => {
  const previous = process.env.APP_ORIGIN;
  process.env.APP_ORIGIN = "https://classroom.example.com";
  try {
    function call(method: string, path: string, origin?: string, header?: string) {
      let nextCalled = false;
      let status = 0;
      const request = { method, path, headers: { origin, "x-school-live-request": header } } as unknown as Request;
      const response = { status: (code: number) => { status = code; return response; }, json: () => response } as unknown as Response;
      csrfProtection(request, response, (() => { nextCalled = true; }) as NextFunction);
      return { nextCalled, status };
    }
    assert.deepEqual(call("POST", "/api/users/student-1/points", "https://evil.example.com", "1"), { nextCalled: false, status: 403 });
    assert.deepEqual(call("POST", "/api/users/student-1/points", "https://classroom.example.com"), { nextCalled: false, status: 403 });
    assert.deepEqual(call("POST", "/api/users/student-1/points", "https://classroom.example.com", "1"), { nextCalled: true, status: 0 });
    assert.deepEqual(call("POST", "/api/webhooks/srs"), { nextCalled: true, status: 0 });
    assert.deepEqual(call("POST", "/api/webhooks/css").status, 403);
  } finally { if (previous === undefined) delete process.env.APP_ORIGIN; else process.env.APP_ORIGIN = previous; }
});

test("健康接口以真实数据库查询结果判定状态", async () => {
  const healthy = new HealthController({ $queryRaw: async () => [{ 1: 1 }] } as unknown as PrismaService);
  assert.deepEqual(await healthy.check(), { ok: true });
  const broken = new HealthController({ $queryRaw: async () => { throw new Error("db down"); } } as unknown as PrismaService);
  await assert.rejects(broken.check(), /数据库不可用/);
});
