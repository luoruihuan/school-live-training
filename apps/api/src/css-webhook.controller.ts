import { createHash } from "node:crypto";
import { BadRequestException, Body, Controller, HttpCode, Post, ServiceUnavailableException } from "@nestjs/common";
import { AlertService } from "./alert.service.js";
import { AuditService } from "./audit.service.js";
import { ChatGateway } from "./chat.gateway.js";
import { recordingRetentionDays } from "./cloud-config.js";
import { cssRecordingKey, verifyCssCallback } from "./css-config.js";
import { object, stringField } from "./input.js";
import { withLiveRoute } from "./live-route.js";
import { PrismaService } from "./prisma.service.js";
import { StorageService } from "./storage.service.js";

@Controller("webhooks")
export class CssWebhookController {
  constructor(private readonly prisma: PrismaService, private readonly storage: StorageService, private readonly audit: AuditService, private readonly chat: ChatGateway, private readonly alert: AlertService) {}

  @Post("css")
  @HttpCode(200)
  async css(@Body() body: unknown) {
    const input = object(body);
    const config = verifyCssCallback(input);
    const streamId = stringField(input, "stream_id", 32);
    if (!/^[a-f0-9]{32}$/.test(streamId)) return { code: 0 };

    if (input.event_type === 0 || input.event_type === 1) {
      await this.updateStream(streamId, input.event_type, input);
    } else if (input.event_type === 100) {
      await this.registerRecording(streamId, input, config);
    }
    return { code: 0 };
  }

  private async updateStream(streamId: string, eventType: 0 | 1, input: Record<string, unknown>): Promise<void> {
    // sequence 是云端的不透明标识，按字符串保存以避免 JS 数字精度损失。
    const sequence = stringField(input, "sequence", 64);
    const timestamp = input.event_time;
    if (typeof timestamp !== "number" || !Number.isSafeInteger(timestamp) || timestamp <= 0 || timestamp > Date.now() / 1000 + 60) {
      throw new BadRequestException("CSS 推断流事件时间无效");
    }
    const eventAt = new Date(timestamp * 1000);
    const result = await withLiveRoute(this.prisma, async (tx, route) => {
      if (route.provider !== "CSS") return;
      const stream = await tx.cssStream.findUnique({ where: { id: streamId }, include: { room: true } });
      if (!stream || stream.routeVersion !== route.version) return;
      const events = await tx.cssPushEvent.findMany({ where: { streamId, sequence }, select: { eventType: true } });
      // 先收到断流也保留记录，重试和迟到的同序列开播不会复活旧连接。
      if (events.some((event) => event.eventType === eventType)) return;
      await tx.cssPushEvent.create({ data: { streamId, sequence, eventType } });
      if (stream.lastStatusAt && stream.lastStatusAt > eventAt) return;
      if (eventType === 1 && events.some((event) => event.eventType === 0)) return;
      if (eventType === 0 && stream.activeSequence !== sequence) return;

      const status: "LIVE" | "ENDED" = eventType === 1 ? "LIVE" : "ENDED";
      const { room } = stream;
      const startedAt = room.status === "LIVE" ? room.lastPublishAt : null;
      const elapsed = startedAt ? Math.max(0, Math.round((eventAt.getTime() - startedAt.getTime()) / 1000)) : 0;
      await tx.cssStream.update({ where: { id: streamId }, data: { activeSequence: eventType === 1 ? sequence : null, lastStatusAt: eventAt } });
      await tx.room.update({ where: { id: room.id }, data: {
        status, lastEventAt: eventAt,
        ...(eventType === 1 ? { lastPublishAt: eventAt } : {}),
        ...(elapsed ? { liveSecondsTotal: { increment: elapsed } } : {})
      } });
      return { room, status };
    });
    if (!result) return;
    const { room, status } = result;
    this.chat.broadcastRoomStatus(room.id, status);
    await this.audit.log({ action: status === "LIVE" ? "PUBLISH_START" : "PUBLISH_STOP", detail: `课堂「${room.title}」${status === "LIVE" ? "开始直播" : "结束直播"}` });
    await this.alert.send(`[${status === "LIVE" ? "live start" : "live end"}] Course "${room.title}" (CSS).`);
  }

  private async registerRecording(streamId: string, input: Record<string, unknown>, config: ReturnType<typeof verifyCssCallback>): Promise<void> {
    const stream = await this.prisma.cssStream.findUnique({ where: { id: streamId }, include: { room: { select: { title: true } } } });
    if (!stream) return;
    if (typeof input.file_format !== "string" || input.file_format.toLowerCase() !== "mp4") {
      throw new BadRequestException("CSS 录制模板须使用 MP4 格式");
    }
    const objectKey = cssRecordingKey(input.video_url, streamId, config);
    const providerId = `css:${createHash("sha256").update(objectKey).digest("hex")}`;
    if (await this.prisma.recording.findUnique({ where: { providerId }, select: { id: true } })) return;

    // 使用后端已有的私有 COS 凭据确认对象，回调 URL 仅用于提取对象键。
    const size = await this.storage.headRecordingSize(objectKey, AbortSignal.timeout(5000)).catch(() => {
      throw new ServiceUnavailableException("CSS 录像对象暂不可读，请重试回调");
    });
    const duration = input.duration;
    const createdAt = new Date();
    const rows = await this.prisma.recording.createMany({ skipDuplicates: true, data: [{
      providerId, objectKey, roomId: stream.roomId, sizeMb: Math.max(1, Math.round(size / 1024 / 1024)),
      durationSecs: typeof duration === "number" && Number.isInteger(duration) && duration > 0 && duration <= 86400 ? duration : null,
      createdAt, expiresAt: new Date(createdAt.getTime() + recordingRetentionDays() * 86400_000)
    }] });
    if (rows.count) await this.audit.log({ action: "RECORDING_SAVED", detail: `课堂「${stream.room.title}」新增回放` });
  }
}
