import "reflect-metadata";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import test from "node:test";
import { ConflictException, ForbiddenException, ServiceUnavailableException } from "@nestjs/common";
import type { UserRequest } from "./auth.guard.js";
import { BusinessController } from "./business.controller.js";
import { CloudWebhookController } from "./cloud-webhook.controller.js";
import { CSS_PLAY_TTL_SECONDS, cssPlaybackAddress, cssPublishAddress, cssRecordingKey, verifyCssCallback } from "./css-config.js";
import { CssWebhookController } from "./css-webhook.controller.js";
import { OpsController } from "./ops.controller.js";
import { PrismaService } from "./prisma.service.js";
import { LIVE_PROVIDER_KEY } from "./live-route.js";

const config = {
  APP_DOMAIN: "live.school.test", SRS_SECRET: "local-test-secret-for-srs",
  CSS_PUSH_DOMAIN: "push.school.test", CSS_PLAY_DOMAIN: "play.school.test", CSS_PUSH_PROTOCOL: "rtmp", CSS_APP_ID: "1234567890",
  CSS_PUSH_KEY: "TestPushKey0123456789", CSS_PLAY_KEY: "TestPlayKey0123456789", CSS_CALLBACK_KEY: "TestCallbackKey0123456789",
  COS_RECORDINGS_BUCKET: "recording-1234567890", COS_REGION: "ap-shanghai",
  COS_ENDPOINT: "https://cos.ap-shanghai.myqcloud.com", COS_SECRET_ID: "test-cos-id", COS_SECRET_KEY: "test-cos-key"
};

function cssEvent(fields: Record<string, unknown>) {
  const t = Math.floor(Date.now() / 1000) + 600;
  return { t, sign: createHash("md5").update(config.CSS_CALLBACK_KEY + t).digest("hex"),
    appid: Number(config.CSS_APP_ID), app: config.CSS_PUSH_DOMAIN, appname: "live", ...fields };
}

test("CSS 签名包含预期过期时间，自适应码率地址按模板名签名，回调仅接受配置的来源和 COS 路径", (t) => {
  const previous = process.env;
  t.after(() => { process.env = previous; });
  process.env = { ...previous, ...config };
  delete process.env.CSS_PUSH_PROTOCOL;
  const publish = new URL(cssPublishAddress("test01", 1543624200).url);
  assert.equal(publish.protocol, "rtmps:");
  assert.equal(publish.port, "443");
  assert.equal(publish.pathname, "/live/test01");
  process.env.CSS_PUSH_PROTOCOL = "rtmp";
  assert.match(cssPublishAddress("test01", 1543624200).url, /^rtmp:\/\/push\.school\.test\/live\/test01\?/);
  const playback = cssPlaybackAddress("test01", 1543624200);
  const url = new URL(playback.hls);
  assert.equal(url.searchParams.get("txTime"), "5C01D608");
  assert.equal(url.searchParams.get("txSecret"), createHash("md5").update(`${config.CSS_PLAY_KEY}test015C01D608`).digest("hex"));
  assert.equal(new Date(playback.expiresAt).getTime(), (1543624200 + CSS_PLAY_TTL_SECONDS) * 1000);
  // 自适应码率：HLS 地址和鉴权串都带「_模板名」，FLV 仍为原始流，推流地址不受影响。
  process.env.CSS_ABR_TEMPLATE = "campus";
  const adaptive = cssPlaybackAddress("test01", 1543624200);
  const adaptiveUrl = new URL(adaptive.hls);
  assert.equal(adaptiveUrl.pathname, "/live/test01_campus.m3u8");
  assert.equal(adaptiveUrl.searchParams.get("txSecret"), createHash("md5").update(`${config.CSS_PLAY_KEY}test01_campus5C01D608`).digest("hex"));
  const flvUrl = new URL(adaptive.flv);
  assert.equal(flvUrl.pathname, "/live/test01.flv");
  assert.equal(flvUrl.searchParams.get("txSecret"), createHash("md5").update(`${config.CSS_PLAY_KEY}test015C01D608`).digest("hex"));
  assert.equal(new URL(cssPublishAddress("test01", 1543624200).url).pathname, "/live/test01");
  process.env.CSS_ABR_TEMPLATE = "123";
  assert.throws(() => cssPlaybackAddress("test01", 1543624200), ServiceUnavailableException);
  delete process.env.CSS_ABR_TEMPLATE;
  const signed = cssEvent({});
  const verified = verifyCssCallback(signed);
  assert.throws(() => verifyCssCallback({ ...signed, sign: "0".repeat(32) }), ForbiddenException);
  assert.throws(() => verifyCssCallback({ ...signed, appid: 42 }), ForbiddenException);
  assert.throws(() => verifyCssCallback({ ...signed, appname: "another" }), ForbiddenException);
  assert.throws(() => verifyCssCallback(signed, signed.t + 1), ForbiddenException);
  const key = "recordings/css/test01/video.mp4";
  assert.equal(cssRecordingKey(`https://recording-1234567890.cos.ap-shanghai.myqcloud.com/${key}?signature=masked`, "test01", verified), key);
  assert.throws(() => cssRecordingKey(`https://example.test/${key}`, "test01", verified), /约定的 COS/);
  assert.throws(() => cssRecordingKey(`https://recording-1234567890.cos.ap-shanghai.myqcloud.com/${key}`, "wrong-stream", verified), /约定的 COS/);
});

test("MySQL：CSS 线路权限、开播锁、回调去重和回切后录制入库", { skip: process.env.RUN_DB_TESTS !== "true" }, async (t) => {
  const previous = process.env;
  process.env = { ...previous, ...config };
  const db = new PrismaService();
  const before = await db.systemSetting.findUnique({ where: { key: LIVE_PROVIDER_KEY } });
  const store = await db.store.create({ data: { name: "CSS 测试店铺" } });
  t.after(async () => {
    try {
      await db.store.delete({ where: { id: store.id } });
      if (before) await db.systemSetting.update({ where: { key: LIVE_PROVIDER_KEY }, data: { value: before.value } });
      else await db.systemSetting.deleteMany({ where: { key: LIVE_PROVIDER_KEY } });
    } finally {
      await db.$disconnect();
      process.env = previous;
    }
  });
  assert.equal(await db.room.count({ where: { status: "LIVE" } }), 0, "请在隔离测试库运行");
  const room = await db.room.create({ data: { storeId: store.id, streamName: randomUUID(), title: "CSS 测试课堂", status: "READY" } });
  const teacher = { currentUser: { role: "TEACHER" } } as UserRequest;
  const student = { currentUser: { role: "STUDENT" } } as UserRequest;
  const admin = { currentUser: { role: "SUPER_ADMIN", displayName: "超管" } } as UserRequest;
  const broadcasts: string[] = [];
  const auditActions: string[] = [];
  const audit = { log: async ({ action }: { action: string }) => { auditActions.push(action); } } as never;
  const chat = { broadcastRoomStatus: (_id: string, status: string) => { broadcasts.push(status); } } as never;
  const notice = { send: async () => undefined } as never;
  const storage = { headRecordingSize: async () => 1024 ** 2 } as never;
  const ops = new OpsController(db, storage, audit, chat);
  const business = new BusinessController(db, storage, audit, chat);
  const css = new CssWebhookController(db, storage, audit, chat, notice);
  const srs = new CloudWebhookController(db, storage, audit, chat, notice);
  await ops.updateLiveProvider(admin, { provider: "SRS" });
  await assert.rejects(ops.updateLiveProvider(teacher, { provider: "CSS" }), ForbiddenException);
  const srsAddress = new URL((await business.publishAddress(teacher, room.id)).url);
  assert.equal(srsAddress.port, "2095");
  assert.equal((await ops.updateLiveProvider(admin, { provider: "CSS" })).liveProvider.value, "CSS");
  await assert.rejects(srs.srs({ action: "on_publish", stream: room.streamName, param: srsAddress.search }), /推流地址已变更/);
  const published = await Promise.all([business.publishAddress(teacher, room.id), business.publishAddress(teacher, room.id)]);
  const url = new URL(published[0].url);
  const streamId = url.pathname.split("/").at(-1)!;
  assert.equal(new URL(published[1].url).pathname, url.pathname);
  assert.equal(url.host, config.CSS_PUSH_DOMAIN);
  assert.equal((await business.playbackAddress(room.id, student)).hls, "");

  const now = Math.floor(Date.now() / 1000) - 60;
  const push = (event_type: number, sequence: string, offset: number) => css.css(cssEvent({ event_type, sequence, stream_id: streamId, event_time: now + offset }));
  await push(0, "first", 2);
  await push(1, "first", 1);
  assert.equal((await business.room(room.id, student)).status, "READY");
  await Promise.all([push(1, "second", 3), push(1, "second", 3)]);
  assert.match((await business.playbackAddress(room.id, student)).hls, /^https:\/\/play\.school\.test\/live\/[a-f0-9]{32}\.m3u8\?txSecret=/);
  await assert.rejects(ops.updateLiveProvider(admin, { provider: "SRS" }), ConflictException);
  await push(1, "third", 7);
  await push(0, "second", 8);
  assert.equal((await business.room(room.id, student)).status, "LIVE");
  await push(0, "third", 15);
  assert.equal((await business.room(room.id, student)).liveSecondsTotal, 12);
  assert.deepEqual(broadcasts, ["LIVE", "LIVE", "ENDED"]);

  await ops.updateLiveProvider(admin, { provider: "SRS" });
  const objectKey = `recordings/css/${streamId}/recording.mp4`;
  const record = cssEvent({ event_type: 100, stream_id: streamId, file_format: "mp4", duration: 12,
    video_url: `https://recording-1234567890.cos.ap-shanghai.myqcloud.com/${objectKey}` });
  await Promise.all([css.css(record), css.css(record)]);
  assert.equal(await db.recording.count({ where: { roomId: room.id, objectKey } }), 1);
  assert.equal(auditActions.filter((action) => action === "RECORDING_SAVED").length, 1);
  await ops.updateLiveProvider(admin, { provider: "CSS" });
  assert.notEqual(new URL((await business.publishAddress(teacher, room.id)).url).pathname, url.pathname);
  await push(1, "stale", 20);
  assert.equal((await business.room(room.id, student)).status, "ENDED");

  const newStreamId = new URL((await business.publishAddress(teacher, room.id)).url).pathname.split("/").at(-1)!;
  const begin = cssEvent({ event_type: 1, stream_id: newStreamId, sequence: "race", event_time: now + 30 });
  const [start, cutover] = await Promise.allSettled([css.css(begin), ops.updateLiveProvider(admin, { provider: "SRS" })]);
  assert.equal(start.status, "fulfilled");
  const current = (await ops.settings(admin)).liveProvider.value;
  const status = (await business.room(room.id, student)).status;
  if (cutover.status === "fulfilled") {
    assert.equal(current, "SRS");
    assert.equal(status, "ENDED");
  } else {
    assert.ok(cutover.reason instanceof ConflictException);
    assert.equal(current, "CSS");
    assert.equal(status, "LIVE");
    await css.css(cssEvent({ ...begin, event_type: 0, event_time: now + 31 }));
  }
});
