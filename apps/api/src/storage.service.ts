import { Injectable, Logger, OnModuleDestroy, OnModuleInit, ServiceUnavailableException } from "@nestjs/common";
import { randomBytes } from "node:crypto";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import type { Readable } from "node:stream";
import { CreateBucketCommand, DeleteObjectCommand, GetObjectCommand, HeadObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { PrismaService } from "./prisma.service.js";
import { recordingRetentionDays } from "./cloud-config.js";

export type ImageMime = "image/jpeg" | "image/png" | "image/webp";

const CLEANUP_INTERVAL_MS = 6 * 60 * 60 * 1000;

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
    this.cleanupTimer = setInterval(() => { void this.cleanupExpired(); }, CLEANUP_INTERVAL_MS);
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
    } catch (error) {
      this.logger.error(`回放清理任务失败：${String(error)}`);
    }
  }
}
