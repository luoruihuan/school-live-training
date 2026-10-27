import { Injectable, Logger, OnModuleDestroy, OnModuleInit, ServiceUnavailableException } from "@nestjs/common";
import { randomBytes } from "node:crypto";
import { createReadStream } from "node:fs";
import { stat, statfs } from "node:fs/promises";
import type { Readable } from "node:stream";
import { CreateBucketCommand, DeleteObjectCommand, GetObjectCommand, HeadObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { PrismaService } from "./prisma.service.js";
import { recordingRetentionDays } from "./cloud-config.js";

export type ImageMime = "image/jpeg" | "image/png" | "image/webp";

const SRS_RAW_DIR = "/var/srs-recordings";
const CLEANUP_INTERVAL_MS = 6 * 60 * 60 * 1000;

function envNumber(name: string, fallback: number): number {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

@Injectable()
export class StorageService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(StorageService.name);
  private readonly buckets = { images: "product-images", recordings: "recordings" } as const;
  private cleanupTimer?: NodeJS.Timeout;

  constructor(private readonly prisma: PrismaService) {}

  private client(): S3Client {
    const endpoint = process.env.MINIO_ENDPOINT;
    const accessKeyId = process.env.MINIO_ROOT_USER;
    const secretAccessKey = process.env.MINIO_ROOT_PASSWORD;
    if (!endpoint || !accessKeyId || !secretAccessKey) {
      throw new ServiceUnavailableException("MinIO 存储未配置，请设置 MINIO_* 环境变量");
    }
    return new S3Client({ endpoint, region: "us-east-1", credentials: { accessKeyId, secretAccessKey }, forcePathStyle: true });
  }

  async onModuleInit(): Promise<void> {
    const s3 = this.client();
    for (const bucket of Object.values(this.buckets)) {
      try {
        await s3.send(new CreateBucketCommand({ Bucket: bucket }));
        this.logger.log(`存储桶已创建：${bucket}`);
      } catch (error) {
        const name = (error as { name?: string }).name;
        if (name === "BucketAlreadyOwnedByYou" || name === "BucketAlreadyExists") this.logger.log(`存储桶就绪：${bucket}`);
        else this.logger.error(`存储桶 ${bucket} 初始化失败：${String(error)}`);
      }
    }
    this.cleanupTimer = setInterval(() => { void this.cleanup(); }, CLEANUP_INTERVAL_MS);
    this.cleanupTimer.unref();
  }

  onModuleDestroy(): void {
    if (this.cleanupTimer) clearInterval(this.cleanupTimer);
  }

  async uploadImage(buffer: Buffer, mimeType: ImageMime): Promise<string> {
    const extension = mimeType === "image/jpeg" ? "jpg" : mimeType === "image/png" ? "png" : "webp";
    const key = `product-images/${randomBytes(16).toString("hex")}.${extension}`;
    await this.client().send(new PutObjectCommand({ Bucket: this.buckets.images, Key: key, Body: buffer, ContentType: mimeType }));
    return key;
  }

  async uploadRecordingFile(key: string, filePath: string, sizeBytes: number): Promise<void> {
    await this.client().send(new PutObjectCommand({
      Bucket: this.buckets.recordings, Key: key,
      Body: createReadStream(filePath), ContentType: "video/mp4", ContentLength: sizeBytes
    }));
  }

  async getImageStream(key: string): Promise<{ stream: Readable; contentType: string }> {
    const result = await this.client().send(new GetObjectCommand({ Bucket: this.buckets.images, Key: key }));
    if (!result.Body) throw new ServiceUnavailableException("图片对象不存在");
    return {
      stream: result.Body as Readable,
      contentType: result.ContentType ?? (key.endsWith(".png") ? "image/png" : key.endsWith(".webp") ? "image/webp" : "image/jpeg")
    };
  }

  async getRecordingStream(key: string, range?: { start: number; end: number }): Promise<{ stream: Readable; contentType: string; contentLength: number }> {
    const result = await this.client().send(new GetObjectCommand({
      Bucket: this.buckets.recordings, Key: key,
      ...(range ? { Range: `bytes=${range.start}-${range.end}` } : {})
    }));
    if (!result.Body) throw new ServiceUnavailableException("回放对象不存在");
    return {
      stream: result.Body as Readable,
      contentType: result.ContentType ?? "video/mp4",
      contentLength: Number(result.ContentLength ?? 0)
    };
  }

  async headRecordingSize(key: string): Promise<number> {
    const result = await this.client().send(new HeadObjectCommand({ Bucket: this.buckets.recordings, Key: key }));
    const length = Number(result.ContentLength ?? 0);
    if (!Number.isSafeInteger(length) || length <= 0) throw new ServiceUnavailableException("回放对象不可读");
    return length;
  }

  async deleteRecording(key: string): Promise<void> {
    await this.client().send(new DeleteObjectCommand({ Bucket: this.buckets.recordings, Key: key }));
  }

  async localRecordingSize(filePath: string): Promise<number> {
    return (await stat(filePath)).size;
  }

  async diskUsagePercent(): Promise<number | null> {
    try {
      const stats = await statfs(SRS_RAW_DIR);
      if (!stats.blocks) return null;
      return Math.round(((stats.blocks - stats.bavail) / stats.blocks) * 10000) / 100;
    } catch {
      return null;
    }
  }

  private async cleanup(): Promise<void> {
    await this.cleanupExpired();
    await this.cleanupByDiskWatermark();
  }

  private async cleanupExpired(): Promise<void> {
    const retentionNote = `保留期 ${recordingRetentionDays()} 天`;
    try {
      const expired = await this.prisma.recording.findMany({ where: { expiresAt: { lte: new Date() } }, select: { id: true, objectKey: true }, take: 100 });
      for (const item of expired) {
        if (item.objectKey) {
          try { await this.deleteRecording(item.objectKey); }
          catch (error) { this.logger.warn(`删除过期回放对象失败 ${item.objectKey}：${String(error)}`); continue; }
        }
        await this.prisma.recording.delete({ where: { id: item.id } }).catch(() => undefined);
      }
      if (expired.length) this.logger.log(`已清理 ${expired.length} 条过期回放（${retentionNote}）`);
      const auditCutoff = new Date(Date.now() - 180 * 24 * 60 * 60 * 1000);
      const removedLogs = await this.prisma.auditLog.deleteMany({ where: { createdAt: { lt: auditCutoff } } });
      if (removedLogs.count) this.logger.log(`已清理 ${removedLogs.count} 条过期操作日志`);
    } catch (error) {
      this.logger.error(`回放清理任务失败：${String(error)}`);
    }
  }

  private async cleanupByDiskWatermark(): Promise<void> {
    const high = envNumber("RECORDING_DISK_HIGH_WATERMARK", 85);
    const low = Math.min(envNumber("RECORDING_DISK_LOW_WATERMARK", 75), high - 1);
    const minKeepDays = envNumber("RECORDING_MIN_RETENTION_DAYS", 90);
    try {
      let usage = await this.diskUsagePercent();
      if (usage === null || usage < high) return;
      const oldestAllowed = new Date(Date.now() - minKeepDays * 24 * 60 * 60 * 1000);
      this.logger.warn(`磁盘使用率 ${usage}% ≥ ${high}%，开始提前清理 ${minKeepDays} 天前的最旧回放`);
      const skipped = new Set<string>();
      let removed = 0;
      while (usage !== null && usage >= low && removed < 200) {
        const candidate = await this.prisma.recording.findFirst({
          where: { createdAt: { lt: oldestAllowed }, id: { notIn: [...skipped] } },
          orderBy: { createdAt: "asc" }
        });
        if (!candidate) break;
        if (candidate.objectKey) {
          try { await this.deleteRecording(candidate.objectKey); }
          catch (error) {
            this.logger.warn(`水位清理删除对象失败 ${candidate.objectKey}：${String(error)}`);
            skipped.add(candidate.id);
            continue;
          }
        }
        await this.prisma.recording.delete({ where: { id: candidate.id } }).catch(() => undefined);
        removed++;
        usage = await this.diskUsagePercent();
      }
      this.logger.log(`水位清理完成：提前删除 ${removed} 条（最小保留 ${minKeepDays} 天，当前磁盘 ${usage ?? "未知"}%）`);
    } catch (error) {
      this.logger.error(`磁盘水位清理失败：${String(error)}`);
    }
  }
}
