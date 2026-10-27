import { Injectable, NotFoundException, type OnModuleDestroy, type OnModuleInit, UnauthorizedException } from "@nestjs/common";
import {
  ConnectedSocket, MessageBody, OnGatewayConnection, SubscribeMessage,
  WebSocketGateway, WebSocketServer
} from "@nestjs/websockets";
import type { Server, Socket } from "socket.io";
import { AuthService, tokenHash } from "./auth.service.js";
import { cookieToken } from "./auth.controller.js";
import { PrismaService } from "./prisma.service.js";
import { visibleRoom } from "./room-access.js";
import { allowedOrigin } from "./request-security.js";

type ChatInput = { roomId?: unknown; content?: unknown };

@Injectable()
@WebSocketGateway({ transports: ["websocket"], allowRequest: (request: { headers: { origin?: string } }, callback: (error: string | null, success: boolean) => void) => callback(null, allowedOrigin(request.headers.origin)) })
export class ChatGateway implements OnGatewayConnection, OnModuleInit, OnModuleDestroy {
  @WebSocketServer() server!: Server;
  private readonly lastMessageAt = new Map<string, number>();

  constructor(private readonly auth: AuthService, private readonly prisma: PrismaService) {}

  private readonly disconnectSession = (hash: string): void => {
    for (const client of this.server?.sockets.sockets.values() ?? []) {
      if (client.data.sessionHash === hash) client.disconnect(true);
    }
  };

  onModuleInit(): void { this.auth.revokedSessions.on("revoked", this.disconnectSession); }
  onModuleDestroy(): void { this.auth.revokedSessions.off("revoked", this.disconnectSession); }

  async handleConnection(client: Socket): Promise<void> {
    try {
      const token = cookieToken(client.handshake);
      if (token) client.data.sessionHash = tokenHash(token);
      const user = await this.auth.userForToken(token);
      if (user.mustChangePassword) throw new UnauthorizedException("请先修改初始密码");
      if (!client.connected) return;
      client.data.userId = user.id;
      client.data.role = user.role;
      const expiry = setTimeout(() => client.disconnect(true), Math.max(0, new Date(user.sessionExpiresAt).getTime() - Date.now()));
      expiry.unref();
      client.once("disconnect", () => clearTimeout(expiry));
    } catch {
      client.disconnect(true);
    }
  }

  @SubscribeMessage("join-room")
  async joinRoom(@ConnectedSocket() client: Socket, @MessageBody() roomId: unknown): Promise<{ ok: boolean; message?: string }> {
    try {
      const user = await this.auth.userForToken(cookieToken(client.handshake));
      if (user.mustChangePassword) throw new UnauthorizedException("请先修改初始密码");
      if (typeof roomId !== "string") {
        return { ok: false, message: "直播间不存在" };
      }
      visibleRoom(await this.prisma.room.findUnique({ where: { id: roomId } }), user.role);
      await client.join(`room:${roomId}`);
      return { ok: true };
    } catch (error) {
      if (error instanceof NotFoundException) return { ok: false, message: "直播间不存在" };
      client.disconnect(true);
      return { ok: false, message: "请先登录" };
    }
  }

  @SubscribeMessage("send-message")
  async sendMessage(@ConnectedSocket() client: Socket, @MessageBody() input: ChatInput): Promise<{ ok: boolean; message?: string }> {
    try {
      const user = await this.auth.userForToken(cookieToken(client.handshake));
      if (user.mustChangePassword) throw new UnauthorizedException("请先修改初始密码");
      if (!input || typeof input.roomId !== "string" || !client.rooms.has(`room:${input.roomId}`)) {
        return { ok: false, message: "请先进入直播间" };
      }
      const room = visibleRoom(await this.prisma.room.findUnique({ where: { id: input.roomId } }), user.role);
      if (typeof input.content !== "string" || !input.content.trim() || input.content.length > 500) {
        return { ok: false, message: "消息长度需为 1～500 字" };
      }
      const mute = await this.prisma.roomMute.findUnique({
        where: { roomId_userId: { roomId: input.roomId, userId: user.id } }
      });
      if (mute && mute.until.getTime() > Date.now()) return { ok: false, message: "当前直播间已禁言" };
      const rateKey = `${user.id}:${input.roomId}`;
      const now = Date.now();
      if (now - (this.lastMessageAt.get(rateKey) ?? 0) < 1500) {
        return { ok: false, message: "发送太快，请稍后再试" };
      }
      this.lastMessageAt.set(rateKey, now);
      const saved = await this.prisma.chatMessage.create({
        data: { roomId: input.roomId, userId: user.id, content: input.content.trim() },
        select: { id: true, roomId: true, content: true, createdAt: true, user: { select: { id: true, displayName: true, role: true } } }
      });
      if (room.status === "DRAFT") {
        await Promise.all([...this.server.sockets.sockets.values()]
          .filter((member) => member.data.role === "STUDENT")
          .map((member) => member.leave(`room:${input.roomId}`)));
      }
      this.server.to(`room:${input.roomId}`).emit("new-message", saved);
      return { ok: true };
    } catch (error) {
      if (error instanceof UnauthorizedException) client.disconnect(true);
      if (error instanceof NotFoundException) return { ok: false, message: "直播间不存在" };
      return { ok: false, message: "发送失败，请重新登录后再试" };
    }
  }

  removeMessage(roomId: string, messageId: string): void {
    this.server.to(`room:${roomId}`).emit("remove-message", { roomId, messageId });
  }

  disconnectUser(userId: string): void {
    for (const client of this.server?.sockets.sockets.values() ?? []) {
      if (client.data.userId === userId) client.disconnect(true);
    }
  }
}
