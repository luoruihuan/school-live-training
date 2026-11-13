import { Controller, Get, NotFoundException, Param, Query, Req, Res, ServiceUnavailableException, UseGuards } from "@nestjs/common";
import type { Response } from "express";
import { AuthGuard, type UserRequest } from "./auth.guard.js";
import { PrismaService } from "./prisma.service.js";
import { StorageService } from "./storage.service.js";
import { visibleRoom } from "./room-access.js";
import { AuditService } from "./audit.service.js";
import { effectiveCdnDomains } from "./system-settings.js";

const MAX_CHUNK = 8 * 1024 * 1024;

@Controller()
@UseGuards(AuthGuard)
export class RecordingController {
  constructor(private readonly prisma: PrismaService, private readonly storage: StorageService, private readonly audit: AuditService) {}

  @Get("rooms/:id/recordings")
  async recordings(@Param("id") id: string, @Req() request: UserRequest) {
    visibleRoom(await this.prisma.room.findUnique({ where: { id } }), request.currentUser);
    return this.prisma.recording.findMany({
      where: { roomId: id, expiresAt: { gt: new Date() }, objectKey: { endsWith: ".mp4" } },
      select: { id: true, durationSecs: true, createdAt: true, expiresAt: true },
      orderBy: { createdAt: "desc" }
    });
  }

  // 同一用户对同一录像 60 秒内重复点击"播放"只记一条日志、计数一次，防止连点刷屏。
  private static readonly REPLAY_DEDUP_MS = 60_000;
  private readonly replaySeen = new Map<string, number>();

  private shouldLogReplay(userId: string, recordingId: string): boolean {
    const key = `${userId}:${recordingId}`;
    const now = Date.now();
    if (this.replaySeen.size > 10_000) this.replaySeen.clear(); // 防御性上限，正常规模远达不到
    const last = this.replaySeen.get(key);
    if (last !== undefined && now - last < RecordingController.REPLAY_DEDUP_MS) return false;
    this.replaySeen.set(key, now);
    return true;
  }

  @Get("recordings/:id/playback")
  async playback(@Param("id") id: string, @Req() request: UserRequest) {
    const recording = await this.visible(id, request);
    // 观看行为在点击播放时记录一次；视频分片请求（/file）高频，写库会拖慢整个系统。
    if (this.shouldLogReplay(request.currentUser.id, recording.id)) {
      await this.prisma.recording.update({ where: { id }, data: { playCount: { increment: 1 } } }).catch(() => undefined);
      await this.audit.log({ action: "REPLAY_PLAYED", userId: request.currentUser.id, actorName: request.currentUser.displayName, request, detail: `${request.currentUser.displayName} 观看回放（课堂 ${recording.roomId.slice(-6).toUpperCase()}）` });
    }
    const remaining = Math.max(1, Math.floor((recording.expiresAt.getTime() - Date.now()) / 1000));
    // 回放 CDN 直连：环境变量能力 × 超管开关，任一不满足都回退 API 代理。
    const { replay: replayCdnOn } = await effectiveCdnDomains(this.prisma);
    const cdn = replayCdnOn && recording.objectKey?.endsWith(".mp4") ? this.storage.recordingPlaybackUrl(recording.objectKey) : null;
    if (cdn) return { url: cdn.url, expiresInSeconds: Math.min(remaining, cdn.expiresInSeconds) };
    return { url: `/api/recordings/${recording.id}/file`, expiresInSeconds: remaining };
  }

  @Get("recordings/:id/file")
  async file(@Param("id") id: string, @Req() request: UserRequest, @Query() query: Record<string, unknown>, @Res() response: Response) {
    void query;
    const recording = await this.visible(id, request);
    // 只读接口：审计日志与 playCount 计数已移至 /playback，这里每个 HTTP Range 分片都会进来，不能写库。
    response.setHeader("Cache-Control", "private, max-age=3600");
    if (!recording.objectKey || !recording.objectKey.endsWith(".mp4")) throw new ServiceUnavailableException("回放文件不可用");
    response.setHeader("Accept-Ranges", "bytes");
    response.setHeader("Content-Type", "video/mp4");
    const header = request.headers.range;
    if (typeof header === "string") {
      const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
      if (match && (match[1] !== "" || match[2] !== "")) {
        const total = await this.storage.headRecordingSize(recording.objectKey);
        let start: number; let end: number;
        if (match[1] === "") {
          const suffix = Math.min(Number(match[2]), total);
          start = Math.max(0, total - suffix); end = total - 1;
        } else {
          start = Number(match[1]); end = match[2] === "" ? total - 1 : Math.min(Number(match[2]), total - 1);
        }
        if (Number.isNaN(start) || Number.isNaN(end) || start > end || start >= total) {
          response.status(416).setHeader("Content-Range", `bytes */${total}`);
        }
        end = Math.min(end, start + MAX_CHUNK - 1);
        const { stream, contentLength } = await this.storage.getRecordingStream(recording.objectKey, { start, end });
        response.status(206).setHeader("Content-Range", `bytes ${start}-${end}/${total}`);
        response.setHeader("Content-Length", String(contentLength));
        stream.pipe(response);
        return;
      }
    }
    const { stream, contentLength } = await this.storage.getRecordingStream(recording.objectKey);
    response.setHeader("Content-Length", String(contentLength));
    stream.pipe(response);
  }

  private async visible(id: string, request: UserRequest) {
    const recording = await this.prisma.recording.findUnique({ where: { id } });
    if (!recording || recording.expiresAt.getTime() <= Date.now()) throw new NotFoundException("回放不存在或已过期");
    visibleRoom(await this.prisma.room.findUnique({ where: { id: recording.roomId } }), request.currentUser);
    return recording;
  }
}
