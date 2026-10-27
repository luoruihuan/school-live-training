import { Controller, Get, NotFoundException, Param, Req, ServiceUnavailableException, UseGuards } from "@nestjs/common";
import { AuthGuard, type UserRequest } from "./auth.guard.js";
import { CosService } from "./cos.service.js";
import { PrismaService } from "./prisma.service.js";
import { visibleRoom } from "./room-access.js";

@Controller()
@UseGuards(AuthGuard)
export class RecordingController {
  constructor(private readonly prisma: PrismaService, private readonly cos: CosService) {}

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
    const recording = await this.prisma.recording.findUnique({ where: { id } });
    if (!recording || recording.expiresAt.getTime() <= Date.now()) throw new NotFoundException("回放不存在或已过期");
    visibleRoom(await this.prisma.room.findUnique({ where: { id: recording.roomId } }), request.currentUser.role);
    if (!recording.objectKey) throw new ServiceUnavailableException("回放文件尚未关联 COS 对象");
    if (!recording.objectKey.toLowerCase().endsWith(".mp4")) {
      throw new ServiceUnavailableException("首版回放仅支持 MP4 录制格式");
    }
    const expiresInSeconds = Math.max(1, Math.min(7200, Math.floor((recording.expiresAt.getTime() - Date.now()) / 1000)));
    return { url: await this.cos.signedReadUrl(recording.objectKey, expiresInSeconds), expiresInSeconds };
  }
}
