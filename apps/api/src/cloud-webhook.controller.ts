import { createHash, timingSafeEqual } from "node:crypto";
import { BadRequestException, Body, Controller, ForbiddenException, HttpCode, Post, ServiceUnavailableException } from "@nestjs/common";
import { object, stringField } from "./input.js";
import { PrismaService } from "./prisma.service.js";
import { recordingRetentionDays } from "./cloud-config.js";

@Controller("webhooks")
export class CloudWebhookController {
  constructor(private readonly prisma: PrismaService) {}

  @Post("css")
  @HttpCode(200)
  async css(@Body() body: unknown) {
    const key = process.env.TENCENT_CALLBACK_KEY;
    if (!key) throw new ServiceUnavailableException("直播回调密钥未配置");
    const input = object(body);
    const timestamp = Number(input.t);
    const signature = input.sign;
    const now = Math.floor(Date.now() / 1000);
    if (!Number.isSafeInteger(timestamp) || timestamp < now || timestamp > now + 3600 || typeof signature !== "string" || !/^[a-f0-9]{32}$/i.test(signature)) {
      throw new ForbiddenException("直播回调鉴权失败");
    }
    const expected = createHash("md5").update(`${key}${timestamp}`).digest();
    if (!timingSafeEqual(expected, Buffer.from(signature, "hex"))) {
      throw new ForbiddenException("直播回调鉴权失败");
    }

    const streamName = stringField(input, "stream_id", 100);
    const room = await this.prisma.room.findUnique({ where: { streamName } });
    if (!room) return { code: 0, msg: "unknown stream ignored" };
    const eventType = Number(input.event_type);
    if (eventType === 1 || eventType === 0) {
      const eventTime = Number(input.event_time);
      if (!Number.isSafeInteger(eventTime) || eventTime < now - 3600 || eventTime > now + 60) {
        throw new BadRequestException("推断流回调事件时间无效");
      }
      const eventAt = new Date(eventTime * 1000);
      await this.prisma.room.updateMany({
        where: { id: room.id, OR: [{ lastEventAt: null }, { lastEventAt: { lt: eventAt } }] },
        data: { status: eventType === 1 ? "LIVE" : "ENDED", lastEventAt: eventAt }
      });
    }
    if (eventType === 100) {
      const durationSecs = Number(input.duration);
      const sourceUrl = typeof input.video_url === "string" ? input.video_url : null;
      let objectKey: string | null = null;
      if (sourceUrl && process.env.COS_BUCKET && process.env.COS_REGION) {
        try {
          const url = new URL(sourceUrl);
          const expectedHost = `${process.env.COS_BUCKET}.cos.${process.env.COS_REGION}.myqcloud.com`;
          if (["https:", "http:"].includes(url.protocol) && url.hostname === expectedHost && !url.username && !url.password && !url.port) objectKey = decodeURIComponent(url.pathname.slice(1));
        } catch { /* 不可信的 URL 不作为 COS 对象处理 */ }
      }
      if (!objectKey || objectKey.length > 191 || !objectKey.toLowerCase().endsWith(".mp4") || /[\x00-\x1f]/.test(objectKey)) {
        throw new BadRequestException("录制回调须提供已配置 COS 桶内的 MP4 地址，请检查录制模板");
      }
      // COS 对象路径比可缺省的点播 file_id 更适合作为录制幂等标识。
      const providerId = `cos:${createHash("sha256").update(`${process.env.COS_BUCKET}/${objectKey}`).digest("hex")}`;
      const endTime = Number(input.end_time);
      const createdAt = new Date(Number.isSafeInteger(endTime) && endTime > 0 && endTime <= now + 300 ? endTime * 1000 : Date.now());
      await this.prisma.recording.upsert({
        where: { providerId }, update: {},
        create: {
          providerId, roomId: room.id,
          durationSecs: Number.isSafeInteger(durationSecs) && durationSecs >= 0 && durationSecs <= 2_147_483_647 ? durationSecs : null,
          sourceUrl,
          objectKey,
          createdAt,
          expiresAt: new Date(createdAt.getTime() + recordingRetentionDays() * 24 * 60 * 60 * 1000)
        }
      });
    }
    return { code: 0, msg: "ok" };
  }
}
