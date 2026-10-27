import { Controller, Get, NotFoundException, Param, Query, Req, Res, ServiceUnavailableException, UseGuards } from "@nestjs/common";
import type { Response } from "express";
import { AuthGuard, type UserRequest } from "./auth.guard.js";
import { PrismaService } from "./prisma.service.js";
import { StorageService } from "./storage.service.js";
import { visibleRoom } from "./room-access.js";

const MAX_CHUNK = 8 * 1024 * 1024;

@Controller()
@UseGuards(AuthGuard)
export class RecordingController {
  constructor(private readonly prisma: PrismaService, private readonly storage: StorageService) {}

  @Get("rooms/:id/recordings")
  async recordings(@Param("id") id: string, @Req() request: UserRequest) {
    visibleRoom(await this.prisma.room.findUnique({ where: { id } }), request.currentUser.role);
    return this.prisma.recording.findMany({
      where: { roomId: id, expiresAt: { gt: new Date() }, objectKey: { endsWith: ".mp4" } },
      select: { id: true, durationSecs: true, createdAt: true, expiresAt: true },
      orderBy: { createdAt: "desc" }
    });
  }

  @Get("recordings/:id/playback")
  async playback(@Param("id") id: string, @Req() request: UserRequest) {
    const recording = await this.visible(id, request);
    return { url: `/api/recordings/${recording.id}/file`, expiresInSeconds: Math.max(1, Math.floor((recording.expiresAt.getTime() - Date.now()) / 1000)) };
  }

  @Get("recordings/:id/file")
  async file(@Param("id") id: string, @Req() request: UserRequest, @Query() query: Record<string, unknown>, @Res({ passthrough: true }) response: Response) {
    void query;
    const recording = await this.visible(id, request);
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
          return;
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
    visibleRoom(await this.prisma.room.findUnique({ where: { id: recording.roomId } }), request.currentUser.role);
    return recording;
  }
}
