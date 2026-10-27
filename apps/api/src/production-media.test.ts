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

const room = { id: "test-room", streamName: "test-stream" };
const prisma = {
  room: { findUnique: async ({ where }: { where: { id: string } }) => where.id === room.id ? room : null },
  recording: { findMany: async () => [], findUnique: async () => null },
  serviceQuota: { findUnique: async () => null }
} as unknown as PrismaService;
const teacher = { currentUser: { role: "TEACHER" } } as UserRequest;
const student = { currentUser: { role: "STUDENT" } } as UserRequest;

test("旧演示配置不能绕过云服务额度与访问权限", async (t) => {
  const previous = process.env;
  t.after(() => { process.env = previous; });
  process.env = { ...previous, MOCK_LIVE: "true" };
  const controller = new BusinessController(prisma, new StorageService({} as never));
  await assert.rejects(controller.publishAddress(teacher, room.id), ServiceUnavailableException);
  await assert.rejects(controller.playbackAddress(room.id, teacher), ServiceUnavailableException);
  await assert.rejects(controller.publishAddress(student, room.id), ForbiddenException);
  await assert.rejects(controller.playbackAddress("missing", teacher), NotFoundException);
});

test("无录制记录时返回空列表，不生成示例回放", async (t) => {
  const previous = process.env;
  t.after(() => { process.env = previous; });
  process.env = { ...previous, MOCK_LIVE: "true" };
  const controller = new RecordingController(prisma, new StorageService({} as never));
  assert.deepEqual(await controller.recordings(room.id, teacher), []);
  await assert.rejects(controller.playback(`mock-recording-${room.id}`, teacher), NotFoundException);
});

test("MinIO 未配置时明确失败，不返回本地演示图片", async (t) => {
  const previous = process.env;
  t.after(() => { process.env = previous; });
  process.env = { ...previous, MOCK_LIVE: "true", MINIO_ENDPOINT: "", MINIO_ROOT_USER: "", MINIO_ROOT_PASSWORD: "" };
  const storage = new StorageService({} as never);
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
