import { BadRequestException, Body, Controller, Delete, Get, NotFoundException, Param, Post, Req, UseGuards } from "@nestjs/common";
import { AuthGuard, requireStaff, type UserRequest } from "./auth.guard.js";
import { ChatGateway } from "./chat.gateway.js";
import { object, stringField } from "./input.js";
import { PrismaService } from "./prisma.service.js";
import { visibleRoom } from "./room-access.js";

@Controller()
@UseGuards(AuthGuard)
export class ChatController {
  constructor(private readonly prisma: PrismaService, private readonly gateway: ChatGateway) {}

  @Get("rooms/:id/messages")
  async messages(@Param("id") id: string, @Req() request: UserRequest) {
    visibleRoom(await this.prisma.room.findUnique({ where: { id } }), request.currentUser.role);
    const messages = await this.prisma.chatMessage.findMany({
      where: { roomId: id, isHidden: false }, take: 50, orderBy: { createdAt: "desc" },
      select: { id: true, roomId: true, content: true, createdAt: true, user: { select: { id: true, displayName: true, role: true } } }
    });
    return messages.reverse();
  }

  @Delete("rooms/:id/messages/:messageId")
  async hideMessage(@Req() request: UserRequest, @Param("id") roomId: string, @Param("messageId") messageId: string) {
    requireStaff(request.currentUser);
    const result = await this.prisma.chatMessage.updateMany({
      where: { id: messageId, roomId }, data: { isHidden: true }
    });
    if (result.count === 0) throw new NotFoundException("消息不存在");
    this.gateway.removeMessage(roomId, messageId);
    return { ok: true };
  }

  @Post("rooms/:id/mutes")
  async mute(@Req() request: UserRequest, @Param("id") roomId: string, @Body() body: unknown) {
    requireStaff(request.currentUser);
    const input = object(body);
    const userId = stringField(input, "userId", 100);
    const [room, user] = await Promise.all([
      this.prisma.room.findUnique({ where: { id: roomId } }),
      this.prisma.user.findUnique({ where: { id: userId } })
    ]);
    if (!room || !user) {
      throw new NotFoundException("直播间或账号不存在");
    }
    if (user.role !== "STUDENT") throw new BadRequestException("仅学生账号可被禁言");
    const until = new Date(Date.now() + 60 * 60 * 1000);
    return this.prisma.roomMute.upsert({
      where: { roomId_userId: { roomId, userId } },
      update: { until }, create: { roomId, userId, until }
    });
  }
}
