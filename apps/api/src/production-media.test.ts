import "reflect-metadata";
import test from "node:test";
import assert from "node:assert/strict";
import { BadRequestException, ForbiddenException, NotFoundException, ServiceUnavailableException } from "@nestjs/common";
import { BusinessController } from "./business.controller.js";
import { RecordingController } from "./recording.controller.js";
import { UploadController } from "./upload.controller.js";
import { StorageService } from "./storage.service.js";
import type { PrismaService } from "./prisma.service.js";
import type { UserRequest } from "./auth.guard.js";
import { AuditService } from "./audit.service.js";
import { cdnTypeAUrl, cdnLiveDomain, replayCdnDomain } from "./cloud-config.js";
const audit = { log: async () => undefined } as unknown as AuditService;

const room = { id: "test-room", streamName: "test-stream" };
const prisma = {
  room: { findUnique: async ({ where }: { where: { id: string } }) => where.id === room.id ? room : null },
  recording: { findMany: async () => [], findUnique: async () => null },
  serviceQuota: { findUnique: async () => null },
  systemSetting: { findMany: async () => [{ key: "cdnLiveEnabled", value: "true" }, { key: "replayCdnEnabled", value: "true" }] }
} as unknown as PrismaService;
const teacher = { currentUser: { role: "TEACHER" } } as UserRequest;
const student = { currentUser: { role: "STUDENT" } } as UserRequest;

test("旧演示配置不能绕过云服务额度与访问权限", async (t) => {
  const previous = process.env;
  t.after(() => { process.env = previous; });
  process.env = { ...previous, MOCK_LIVE: "true" };
  const controller = new BusinessController(prisma, new StorageService({} as never, {} as never), audit, { broadcastRoomProducts: () => undefined } as never);
  await assert.rejects(controller.publishAddress(teacher, room.id), ServiceUnavailableException);
  await assert.rejects(controller.playbackAddress(room.id, teacher), ServiceUnavailableException);
  await assert.rejects(controller.publishAddress(student, room.id), ForbiddenException);
  await assert.rejects(controller.playbackAddress("missing", teacher), NotFoundException);
});

test("无录制记录时返回空列表，不生成示例回放", async (t) => {
  const previous = process.env;
  t.after(() => { process.env = previous; });
  process.env = { ...previous, MOCK_LIVE: "true" };
  const controller = new RecordingController(prisma, new StorageService({} as never, {} as never), audit);
  assert.deepEqual(await controller.recordings(room.id, teacher), []);
  await assert.rejects(controller.playback(`mock-recording-${room.id}`, teacher), NotFoundException);
});

test("MinIO 未配置时明确失败，不返回本地演示图片", async (t) => {
  const previous = process.env;
  t.after(() => { process.env = previous; });
  process.env = { ...previous, MOCK_LIVE: "true", MINIO_ENDPOINT: "", MINIO_ROOT_USER: "", MINIO_ROOT_PASSWORD: "" };
  const storage = new StorageService({} as never, {} as never);
  await assert.rejects(storage.getImageStream(`product-images/${"a".repeat(32)}.png`), ServiceUnavailableException);
});

test("真实图片上传保留角色与文件内容校验", async () => {
  let uploaded = false;
  const cos = { uploadImage: async (buffer: Buffer, mime: string) => { assert.equal(mime, "image/png"); assert.equal(buffer.length, 8); uploaded = true; return "product-images/validated.png"; } } as unknown as StorageService;
  const controller = new UploadController(cos);
  const png = { buffer: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]) } as Express.Multer.File;
  await assert.rejects(controller.image(student, png), ForbiddenException);
  await assert.rejects(controller.image(teacher, { buffer: Buffer.from("invalid") } as Express.Multer.File), BadRequestException);
  assert.equal(uploaded, false);
  assert.deepEqual(await controller.image(teacher, png), { imageKey: "product-images/validated.png" });
  assert.equal(uploaded, true);
});

test("CDN TypeA 签名与腾讯云官方文档向量一致", () => {
  // 官方文档《CDN TypeA》示例：uri=/test.jpg ts=1582791032 rand=im1acp76sx9sdqe601v uid=0 pkey=dimtm5evg50ijsx2hvuwyfoiu65
  const url = cdnTypeAUrl("www.test.com", "/test.jpg", "dimtm5evg50ijsx2hvuwyfoiu65", 1582791032, "im1acp76sx9sdqe601v");
  assert.equal(url, "https://www.test.com/test.jpg?sign=1582791032-im1acp76sx9sdqe601v-0-3fbb88382c9356b6faaf9d68c7b2ae3a");
});

test("CDN 域名读取容错：剥协议尾斜杠、非法格式报错、留空回退", (t) => {
  const previous = process.env;
  t.after(() => { process.env = previous; });
  process.env = { ...previous, CDN_LIVE_DOMAIN: "https://live-cdn.example.com/", REPLAY_CDN_DOMAIN: "" };
  assert.equal(cdnLiveDomain(), "live-cdn.example.com");
  assert.equal(replayCdnDomain(), undefined);
  process.env = { ...previous, CDN_LIVE_DOMAIN: "live-cdn.example.com/path" };
  assert.throws(() => cdnLiveDomain(), /须为域名/);
});

test("直播播放地址：配置 CDN 且开关开启后走 CDN，未配置回退源站", async (t) => {
  const previous = process.env;
  t.after(() => { process.env = previous; });
  const controller = new BusinessController(prisma, new StorageService({} as never, {} as never), audit, { broadcastRoomProducts: () => undefined } as never);
  process.env = { ...previous, APP_DOMAIN: "origin.demo-school.cn" };
  const direct = await controller.playbackAddress(room.id, teacher);
  assert.equal(direct.flv, "https://origin.demo-school.cn/live/test-stream.flv");
  process.env = { ...previous, APP_DOMAIN: "origin.demo-school.cn", CDN_LIVE_DOMAIN: "live-cdn.example.com" };
  const cdn = await controller.playbackAddress(room.id, teacher);
  assert.equal(cdn.flv, "https://live-cdn.example.com/live/test-stream.flv");
  assert.equal(cdn.hls, "https://live-cdn.example.com/live/test-stream.m3u8");
});

test("回放播放地址：回放 CDN 开关开启后直连 CDN 且观看仍只记一次，未配置回退 API 代理", async (t) => {
  const previous = process.env;
  t.after(() => { process.env = previous; });
  const recording = { id: "rec1", roomId: room.id, objectKey: `recordings/${room.id}/a.mp4`, expiresAt: new Date(Date.now() + 86_400_000) };
  let playCount = 0; let auditCalls = 0;
  const replayPrisma = {
    room: { findUnique: async () => ({ id: room.id, status: "ENDED" }) },
    recording: { findUnique: async () => recording, update: async () => { playCount++; } },
    systemSetting: { findMany: async () => [{ key: "replayCdnEnabled", value: "true" }] }
  } as unknown as PrismaService;
  const replayAudit = { log: async () => { auditCalls++; } } as unknown as AuditService;
  const viewer = { currentUser: { id: "u1", displayName: "同学", role: "STUDENT" } } as UserRequest;

  process.env = { ...previous };
  const fallback = new RecordingController(replayPrisma, new StorageService({} as never, {} as never), replayAudit);
  const r1 = await fallback.playback(recording.id, viewer);
  assert.equal(r1.url, `/api/recordings/${recording.id}/file`);

  process.env = { ...previous, REPLAY_CDN_DOMAIN: "replay-cdn.example.com", CDN_URL_AUTH_KEY: "testkey123" };
  const cdn = new RecordingController(replayPrisma, new StorageService({} as never, {} as never), replayAudit);
  const r2 = await cdn.playback(recording.id, viewer);
  assert.match(r2.url, /^https:\/\/replay-cdn\.example\.com\/recordings\/test-room\/a\.mp4\?sign=\d+-0-0-[0-9a-f]{32}$/);
  assert.equal(r2.expiresInSeconds, 6 * 60 * 60);
  await cdn.playback(recording.id, viewer); // 60 秒去重：不重复计数
  assert.equal(playCount, 2);
  assert.equal(auditCalls, 2);
});

const cdnRecording = { id: "rec-cdn", roomId: room.id, objectKey: `recordings/${room.id}/cdn.mp4`, expiresAt: new Date(Date.now() + 86_400_000) };

test("CDN 开关：开启后直播与回放走 CDN，关闭立即回退直连", async (t) => {
  const previous = process.env;
  t.after(() => { process.env = previous; });
  process.env = { ...previous, APP_DOMAIN: "origin.demo-school.cn", CDN_LIVE_DOMAIN: "live-cdn.example.com", REPLAY_CDN_DOMAIN: "replay-cdn.example.com" };
  const { effectiveCdnDomains } = await import("./system-settings.js");
  let rows: { key: string; value: string }[] = [];
  const switchPrisma = {
    room: { findUnique: async () => ({ id: room.id, streamName: room.streamName, status: "ENDED" }) },
    recording: { findUnique: async () => cdnRecording, update: async () => ({}) },
    systemSetting: { findMany: async () => rows }
  } as unknown as PrismaService;
  const viewer = { currentUser: { id: "u1", displayName: "同学", role: "STUDENT" } } as UserRequest;

  const business = new BusinessController(switchPrisma, new StorageService({} as never, {} as never), audit, { broadcastRoomProducts: () => undefined } as never);
  const recordingCtl = new RecordingController(switchPrisma, new StorageService({} as never, {} as never), audit);

  // 默认（未开启）：直连源站 + API 代理
  assert.equal((await business.playbackAddress(room.id, teacher)).flv, "https://origin.demo-school.cn/live/test-stream.flv");
  assert.equal((await recordingCtl.playback(cdnRecording.id, viewer)).url, `/api/recordings/${cdnRecording.id}/file`);

  // 开启后：CDN 域名
  rows = [{ key: "cdnLiveEnabled", value: "true" }, { key: "replayCdnEnabled", value: "true" }];
  assert.equal((await business.playbackAddress(room.id, teacher)).flv, "https://live-cdn.example.com/live/test-stream.flv");
  assert.match((await recordingCtl.playback(cdnRecording.id, viewer)).url, /^https:\/\/replay-cdn\.example\.com\/recordings\//);

  // 开关读取异常：按关闭处理，播放不受影响
  const brokenPrisma = { ...switchPrisma, systemSetting: { findMany: async () => { throw new Error("db down"); } } } as unknown as PrismaService;
  const switches = await (await import("./system-settings.js")).cdnSwitches(brokenPrisma);
  assert.deepEqual(switches, { live: false, replay: false });
  const domains = await effectiveCdnDomains(brokenPrisma);
  assert.equal(domains.live, undefined);
  assert.equal(domains.replay, undefined);
});

test("CDN 设置接口：仅超管可操作，能力未配置时不允许开启", async (t) => {
  const previous = process.env;
  t.after(() => { process.env = previous; });
  process.env = { ...previous, CDN_LIVE_DOMAIN: "", REPLAY_CDN_DOMAIN: "" };
  const { OpsController } = await import("./ops.controller.js");
  const upserts: { key: string; value: string }[] = [];
  let auditCalls = 0;
  const opsPrisma = { systemSetting: { findMany: async () => upserts.filter((row) => row.value), upsert: async ({ data }: { data: { key: string; value: string } }) => { upserts.push(data); return data; } } } as unknown as PrismaService;
  const controller = new OpsController(opsPrisma, {} as never, { log: async () => { auditCalls++; } } as unknown as AuditService);
  const superAdmin = { currentUser: { id: "sa", role: "SUPER_ADMIN", displayName: "超管" } } as UserRequest;
  const plainAdmin = { currentUser: { id: "ad", role: "ADMIN", displayName: "管理员" } } as UserRequest;

  await assert.rejects(controller.settings(plainAdmin), ForbiddenException);
  await assert.rejects(controller.updateSettings(plainAdmin, { cdnLiveEnabled: true }), ForbiddenException);
  await assert.rejects(controller.updateSettings(superAdmin, { cdnLiveEnabled: true }), /CDN_LIVE_DOMAIN/); // 能力未配置
  const result = await controller.updateSettings(superAdmin, { cdnLiveEnabled: false }); // 关闭总是允许
  assert.equal(result.cdnLive.enabled, false);
  assert.equal(auditCalls, 1);
});
