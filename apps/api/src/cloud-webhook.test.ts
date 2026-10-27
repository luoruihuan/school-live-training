import "reflect-metadata";
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { CloudWebhookController } from "./cloud-webhook.controller.js";
import { BusinessController } from "./business.controller.js";
import { CosService } from "./cos.service.js";
import type { PrismaService } from "./prisma.service.js";
import type { UserRequest } from "./auth.guard.js";

test("COS 回调无需 VOD file_id，重复通知只保留一个回放且不延长有效期", async (t) => {
  const previous = process.env;
  t.after(() => { process.env = previous; });
  process.env = { ...previous, TENCENT_CALLBACK_KEY: "test-callback", COS_BUCKET: "school-123", COS_REGION: "ap-guangzhou", RECORDING_RETENTION_DAYS: "7" };
  const rows = new Map<string, { providerId: string; objectKey: string; expiresAt: Date; createdAt: Date }>();
  const prisma = {
    room: { findUnique: async () => ({ id: "room1" }) },
    recording: { upsert: async ({ where, create }: { where: { providerId: string }; create: { providerId: string; objectKey: string; expiresAt: Date; createdAt: Date } }) => { if (!rows.has(where.providerId)) rows.set(where.providerId, create); } }
  } as unknown as PrismaService;
  const callback = new CloudWebhookController(prisma);
  const timestamp = Math.floor(Date.now() / 1000) + 600;
  const end = Math.floor(Date.now() / 1000) - 300;
  const event = { stream_id: "stream1", event_type: 100, t: timestamp, sign: createHash("md5").update(`test-callback${timestamp}`).digest("hex"), video_url: "https://school-123.cos.ap-guangzhou.myqcloud.com/recordings/stream1/lesson%20one.mp4", file_format: "mp4", duration: 60, end_time: end };
  await callback.css(event);
  await callback.css(event);
  assert.equal(rows.size, 1);
  const row = [...rows.values()][0]!;
  assert.equal(row.objectKey, "recordings/stream1/lesson one.mp4");
  assert.equal(row.expiresAt.getTime(), (end + 7 * 86400) * 1000);
  await assert.rejects(callback.css({ ...event, sign: "0".repeat(32) }), /鉴权失败/);
  await assert.rejects(callback.css({ ...event, video_url: "https://school-123.cos.ap-guangzhou.myqcloud.com.evil.test/x.mp4" }), /COS/);
});

test("配置检查不返回密钥值，学生不能读取", (t) => {
  const previous = process.env;
  t.after(() => { process.env = previous; });
  process.env = { ...previous, COS_SECRET_KEY: "should-never-be-returned", TENCENT_PUSH_DOMAIN: "push.example.com" };
  const business = new BusinessController({} as PrismaService, new CosService());
  const result = business.cloudStatus({ currentUser: { role: "ADMIN" } } as UserRequest);
  assert.equal(result.settings.find((f) => f.name === "TENCENT_PUSH_DOMAIN")?.configured, false);
  assert.ok(!JSON.stringify(result).includes("should-never-be-returned"));
  assert.throws(() => business.cloudStatus({ currentUser: { role: "STUDENT" } } as UserRequest), /仅管理员/);
});

test("迟到或重放的断流回调不能覆盖较新的开播状态", async (t) => {
  const previous = process.env;
  t.after(() => { process.env = previous; });
  process.env = { ...previous, TENCENT_CALLBACK_KEY: "test-callback" };
  let status = "ENDED";
  let lastEventAt: Date | null = null;
  const prisma = {
    room: {
      findUnique: async () => ({ id: "room1" }),
      updateMany: async ({ where, data }: { where: { OR: [{ lastEventAt: null }, { lastEventAt: { lt: Date } }] }; data: { status: string; lastEventAt: Date } }) => {
        if (!lastEventAt || lastEventAt < where.OR[1].lastEventAt.lt) {
          status = data.status;
          lastEventAt = data.lastEventAt;
          return { count: 1 };
        }
        return { count: 0 };
      }
    }
  } as unknown as PrismaService;
  const now = Math.floor(Date.now() / 1000);
  const tValue = now + 600;
  const sign = createHash("md5").update(`test-callback${tValue}`).digest("hex");
  const callback = new CloudWebhookController(prisma);
  await callback.css({ stream_id: "stream1", event_type: 1, event_time: now - 10, t: tValue, sign });
  await callback.css({ stream_id: "stream1", event_type: 0, event_time: now - 20, t: tValue, sign });
  assert.equal(status, "LIVE");
  await assert.rejects(callback.css({ stream_id: "stream1", event_type: 0, event_time: now - 7200, t: tValue, sign }), /事件时间无效/);
});
