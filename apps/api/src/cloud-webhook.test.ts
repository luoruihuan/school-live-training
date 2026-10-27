import "reflect-metadata";
import test from "node:test";
import assert from "node:assert/strict";
import { createHash, createHmac } from "node:crypto";
import { CloudWebhookController, publishToken } from "./cloud-webhook.controller.js";
import { BusinessController } from "./business.controller.js";
import { StorageService } from "./storage.service.js";
import type { PrismaService } from "./prisma.service.js";
import type { UserRequest } from "./auth.guard.js";

function mockStorage(rawDir: string): StorageService {
  return {
    localRecordingSize: async () => 1024,
    uploadRecordingFile: async (key: string, path: string) => { void key; void path; },
    deleteRecording: async () => undefined
  } as unknown as StorageService;
}

test("SRS 推流回调校验 token：合法放行、无效拒绝、过期拒绝", async (t) => {
  const previous = process.env;
  t.after(() => { process.env = previous; });
  process.env = { ...previous, SRS_SECRET: "unit-test-secret-16chars" };
  let status = "ENDED";
  const prisma = {
    room: {
      findUnique: async () => ({ id: "room1" }),
      updateMany: async ({ data }: { data: { status: string } }) => { status = data.status; return { count: 1 }; }
    }
  } as unknown as PrismaService;
  const callback = new CloudWebhookController(prisma, mockStorage(""));
  const expire = Math.floor(Date.now() / 1000) + 3600;
  const token = publishToken("stream1", expire);
  await callback.srs({ action: "on_publish", stream: "stream1", param: `?token=${token}&expire=${expire}` });
  assert.equal(status, "LIVE");
  await assert.rejects(callback.srs({ action: "on_publish", stream: "stream1", param: `?token=${"0".repeat(32)}&expire=${expire}` }), /推流鉴权失败/);
  const past = Math.floor(Date.now() / 1000) - 10;
  await assert.rejects(callback.srs({ action: "on_publish", stream: "stream1", param: `?token=${publishToken("stream1", past)}&expire=${past}` }), /推流鉴权失败/);
  await callback.srs({ action: "on_unpublish", stream: "stream1", param: "" });
  assert.equal(status, "ENDED");
});

test("SRS 录制回调：入库幂等，非法路径拒绝，SRS 容器路径映射正确", async (t) => {
  const previous = process.env;
  t.after(() => { process.env = previous; });
  process.env = { ...previous, SRS_SECRET: "unit-test-secret-16chars", RECORDING_RETENTION_DAYS: "7" };
  const rows = new Map<string, { objectKey: string; expiresAt: Date; roomId: string }>();
  const prisma = {
    room: { findUnique: async () => ({ id: "room1" }) },
    recording: {
      findUnique: async ({ where }: { where: { providerId: string } }) => rows.get(where.providerId) ?? null,
      create: async ({ data }: { data: { providerId: string; objectKey: string; expiresAt: Date; roomId: string } }) => { rows.set(data.providerId, data); return data; }
    }
  } as unknown as PrismaService;
  const storage = {
    localRecordingSize: async () => 16,
    uploadRecordingFile: async () => undefined,
    deleteRecording: async () => undefined
  } as unknown as StorageService;
  const controller = new CloudWebhookController(prisma, storage);
  const fileName = "stream1-1698400000.mp4";
  await controller.srs({ action: "on_dvr", stream: "stream1", file: `/data/recordings/${fileName}` });
  await controller.srs({ action: "on_dvr", stream: "stream1", file: `/data/recordings/${fileName}` });
  assert.equal(rows.size, 1);
  const row = [...rows.values()][0]!;
  assert.equal(row.objectKey, `recordings/room1/${fileName}`);
  assert.equal(row.roomId, "room1");
  const retentionMs = row.expiresAt.getTime() - Date.now();
  assert.ok(retentionMs > 6 * 86400_000 && retentionMs <= 8 * 86400_000);
  await assert.rejects(controller.srs({ action: "on_dvr", stream: "stream1", file: "/etc/passwd" }), /路径不合法/);
  await assert.rejects(controller.srs({ action: "on_dvr", stream: "stream1", file: "/data/recordings/evil.txt" }), /路径不合法/);
  await assert.rejects(controller.srs({ action: "unknown", stream: "stream1" }), /未知/);
});

