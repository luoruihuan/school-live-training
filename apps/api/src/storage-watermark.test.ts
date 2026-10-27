import "reflect-metadata";
import test from "node:test";
import assert from "node:assert/strict";
import { StorageService } from "./storage.service.js";
import type { PrismaService } from "./prisma.service.js";

type RecordingRow = { id: string; objectKey: string; createdAt: Date; expiresAt: Date };

function makeService(rows: RecordingRow[], usageSequence: (number | null)[]): StorageService {
  const prisma = {
    recording: {
      findMany: async () => rows.filter((row) => row.expiresAt.getTime() <= Date.now()),
      findFirst: async () => rows.filter((row) => row.createdAt.getTime() < Date.now() - 90 * 86400_000).sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())[0] ?? null,
      delete: async ({ where }: { where: { id: string } }) => { const index = rows.findIndex((row) => row.id === where.id); if (index >= 0) rows.splice(index, 1); }
    }
  } as unknown as PrismaService;
  const service = new StorageService(prisma);
  const usages = [...usageSequence];
  service.diskUsagePercent = async () => usages.shift() ?? usages[usages.length - 1] ?? null;
  return service;
}

const day = 86400_000;

test("磁盘高于高水位时提前删最旧回放，且不碰 90 天内的记录，降到低水位即停", async () => {
  const old1: RecordingRow = { id: "r-old1", objectKey: "recordings/a/1.mp4", createdAt: new Date(Date.now() - 150 * day), expiresAt: new Date(Date.now() + 30 * day) };
  const old2: RecordingRow = { id: "r-old2", objectKey: "recordings/a/2.mp4", createdAt: new Date(Date.now() - 120 * day), expiresAt: new Date(Date.now() + 60 * day) };
  const recent: RecordingRow = { id: "r-new", objectKey: "recordings/a/3.mp4", createdAt: new Date(Date.now() - 30 * day), expiresAt: new Date(Date.now() + 150 * day) };
  const rows = [recent, old2, old1];
  const deleted: string[] = [];
  const service = makeService(rows, [90, 90, 74]);
  service.deleteRecording = async (key: string) => { deleted.push(key); };
  await (service as unknown as { cleanupByDiskWatermark: () => Promise<void> }).cleanupByDiskWatermark();
  assert.deepEqual(deleted, ["recordings/a/1.mp4", "recordings/a/2.mp4"]);
  assert.deepEqual(rows.map((row) => row.id), ["r-new"]);
});

test("磁盘未达高水位或没有可删记录时不动作", async () => {
  const rows: RecordingRow[] = [
    { id: "r-new", objectKey: "recordings/a/3.mp4", createdAt: new Date(Date.now() - 10 * day), expiresAt: new Date(Date.now() + 170 * day) }
  ];
  let deleted = 0;
  const service = makeService(rows, [50]);
  service.deleteRecording = async () => { deleted++; };
  await (service as unknown as { cleanupByDiskWatermark: () => Promise<void> }).cleanupByDiskWatermark();
  assert.equal(deleted, 0);

  const service2 = makeService(rows, [95, 95, 95]);
  service2.deleteRecording = async () => { deleted++; };
  await (service2 as unknown as { cleanupByDiskWatermark: () => Promise<void> }).cleanupByDiskWatermark();
  assert.equal(deleted, 0);
  assert.equal(rows.length, 1);
});
