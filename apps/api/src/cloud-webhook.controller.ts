import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { unlink } from "node:fs/promises";
import { BadRequestException, Body, Controller, HttpCode, NotFoundException, Post, ServiceUnavailableException } from "@nestjs/common";
import { object, stringField } from "./input.js";
import { PrismaService } from "./prisma.service.js";
import { StorageService } from "./storage.service.js";
import { recordingRetentionDays } from "./cloud-config.js";
import { AuditService } from "./audit.service.js";

const SRS_RAW_DIR = "/var/srs-recordings";
const SRS_CONTAINER_DIR = "/data/recordings";

function srsSecret(): string {
  const key = process.env.SRS_SECRET;
  if (!key || key.length < 16) throw new ServiceUnavailableException("SRS 推流鉴权密钥未配置");
  return key;
}

export function publishToken(streamName: string, expiresAtEpoch: number): string {
  return createHmac("sha256", srsSecret()).update(`${streamName}-${expiresAtEpoch}`).digest("hex").slice(0, 32);
}

function verifyPublishToken(streamName: string, param: string): boolean {
  const query = param.startsWith("?") ? param.slice(1) : param;
  const token = new URLSearchParams(query).get("token") ?? "";
  const expire = Number(new URLSearchParams(query).get("expire"));
  if (!/^[a-f0-9]{32}$/.test(token) || !Number.isSafeInteger(expire)) return false;
  const expected = Buffer.from(publishToken(streamName, expire), "hex");
  const actual = Buffer.from(token, "hex");
  return actual.length === expected.length && timingSafeEqual(expected, actual) && expire > Math.floor(Date.now() / 1000);
}

@Controller("webhooks")
export class CloudWebhookController {
  constructor(private readonly prisma: PrismaService, private readonly storage: StorageService, private readonly audit: AuditService) {}

  @Post("srs")
  @HttpCode(200)
  async srs(@Body() body: unknown) {
    const input = object(body);
    const action = stringField(input, "action", 40);
    const streamName = stringField(input, "stream", 100);
    const room = await this.prisma.room.findUnique({ where: { streamName } });
    if (!room) return 0;

    if (action === "on_publish" || action === "on_unpublish") {
      if (action === "on_publish" && !verifyPublishToken(streamName, typeof input.param === "string" ? input.param : "")) {
        throw new NotFoundException("推流鉴权失败");
      }
      const eventAt = new Date();
      const patch: { status: "LIVE" | "ENDED"; lastEventAt: Date; lastPublishAt?: Date; liveSecondsTotal?: { increment: number } } = {
        status: action === "on_publish" ? "LIVE" : "ENDED", lastEventAt: eventAt
      };
      if (action === "on_publish") patch.lastPublishAt = eventAt;
      else if (room.lastPublishAt) patch.liveSecondsTotal = { increment: Math.max(0, Math.round((eventAt.getTime() - room.lastPublishAt.getTime()) / 1000)) };
      await this.prisma.room.updateMany({
        where: { id: room.id, OR: [{ lastEventAt: null }, { lastEventAt: { lt: eventAt } }] },
        data: patch
      });
      await this.audit.log({
        action: action === "on_publish" ? "PUBLISH_START" : "PUBLISH_STOP",
        detail: `课堂「${room.title}」${action === "on_publish" ? "开始直播" : `结束直播${room.lastPublishAt ? `（时长约 ${Math.round((eventAt.getTime() - room.lastPublishAt.getTime()) / 60000)} 分钟）` : ""}`}`
      });
      return 0;
    }

    if (action === "on_dvr") {
      const filePath = typeof input.file === "string" ? input.file : "";
      const fileName = filePath.split("/").pop() ?? "";
      if (!filePath.startsWith(`${SRS_CONTAINER_DIR}/`) || !fileName.toLowerCase().endsWith(".mp4") || fileName.includes("/") || fileName.length > 191 || /[\x00-\x1f]/.test(fileName)) {
        throw new BadRequestException("录制回调文件路径不合法");
      }
      const localPath = `${SRS_RAW_DIR}/${fileName}`;
      const objectKey = `recordings/${room.id}/${fileName}`;
      const providerId = `srs:${createHash("sha256").update(objectKey).digest("hex")}`;
      const existing = await this.prisma.recording.findUnique({ where: { providerId } });
      if (existing) return 0;
      const sizeBytes = await this.storage.localRecordingSize(localPath);
      await this.storage.uploadRecordingFile(objectKey, localPath, sizeBytes);
      const createdAt = new Date();
      await this.prisma.recording.create({
        data: {
          providerId, roomId: room.id, objectKey, durationSecs: null, sizeMb: Math.max(1, Math.round(sizeBytes / 1024 / 1024)), createdAt,
          expiresAt: new Date(createdAt.getTime() + recordingRetentionDays() * 24 * 60 * 60 * 1000)
        }
      });
      await this.audit.log({ action: "RECORDING_SAVED", detail: `课堂「${room.title}」新增回放（约 ${Math.max(1, Math.round(sizeBytes / 1024 / 1024))} MB）` });
      await unlink(localPath).catch(() => undefined);
      return 0;
    }

    throw new BadRequestException("未知的 SRS 回调动作");
  }
}
