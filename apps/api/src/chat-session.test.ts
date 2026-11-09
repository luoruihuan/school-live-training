import "reflect-metadata";
import test from "node:test";
import assert from "node:assert/strict";
import type { Server } from "socket.io";
import { ChatGateway } from "./chat.gateway.js";
import type { AuthService } from "./auth.service.js";
import type { PrismaService } from "./prisma.service.js";
import { EventEmitter } from "node:events";
import { AuthService as RealAuthService, tokenHash } from "./auth.service.js";
import { AuditService } from "./audit.service.js";
const audit = { log: async () => undefined } as unknown as AuditService;

test("停用或重置后断开该用户全部互动连接，其他用户不受影响", () => {
  const disconnected: string[] = [];
  const chat = new ChatGateway({} as AuthService, {} as PrismaService);
  chat.server = { sockets: { sockets: new Map(["a", "b", "c"].map((id) => [id, { data: { userId: id === "c" ? "other" : "revoked" }, disconnect: () => disconnected.push(id) }])) } } as unknown as Server;
  chat.disconnectUser("revoked");
  assert.deepEqual(disconnected, ["a", "b"]);
});

test("退出只断开该会话的连接，其他设备会话保留", async () => {
  const auth = new RealAuthService({ session: { deleteMany: async () => ({ count: 1 }) } } as unknown as PrismaService, audit);
  const disconnected: string[] = [];
  const chat = new ChatGateway(auth, {} as PrismaService);
  chat.server = { sockets: { sockets: new Map(["same-tab", "second-tab", "other-device"].map((id) => [id, { data: { sessionHash: tokenHash(id === "other-device" ? "other-token" : "shared-token") }, disconnect: () => disconnected.push(id) }])) } } as unknown as Server;
  chat.onModuleInit();
  try {
    await auth.logout("shared-token");
    assert.deepEqual(disconnected, ["same-tab", "second-tab"]);
  } finally { chat.onModuleDestroy(); }
});

test("会话到期会主动断开空闲连接，无需等待用户发送消息", async () => {
  let disconnected = false;
  const client = Object.assign(new EventEmitter(), { data: {} as Record<string, unknown>, connected: true, handshake: { headers: { cookie: "sid=expiring" } }, disconnect: () => { disconnected = true; client.emit("disconnect"); } });
  const auth = { userForToken: async () => ({ id: "u", sessionExpiresAt: new Date(Date.now() + 15).toISOString() }) } as unknown as AuthService;
  const chat = new ChatGateway(auth, {} as PrismaService);
  await chat.handleConnection(client as unknown as import("socket.io").Socket);
  await new Promise((resolve) => setTimeout(resolve, 40));
  assert.equal(disconnected, true);
});

function chatClient(): import("socket.io").Socket {
  return Object.assign(new EventEmitter(), { data: {}, rooms: new Set(["room:room-1"]), join: async () => undefined, leave: async () => undefined, handshake: { headers: {} }, disconnect: () => undefined }) as unknown as import("socket.io").Socket;
}

test("未开播的课堂拒绝发言，开播后才能发送消息", async () => {
  let roomStatus = "READY";
  let created = 0;
  const emitted: string[] = [];
  const auth = { userForToken: async () => ({ id: "u1", role: "STUDENT", mustChangePassword: false, sessionExpiresAt: new Date(Date.now() + 3600_000).toISOString() }) } as unknown as AuthService;
  const prisma = {
    room: { findUnique: async () => ({ id: "room-1", status: roomStatus }) },
    roomMute: { findUnique: async () => null },
    chatMessage: { create: async () => { created += 1; return { id: "m1", roomId: "room-1", content: "hi", createdAt: new Date().toISOString(), user: { id: "u1", displayName: "同学", role: "STUDENT" } }; } }
  } as unknown as PrismaService;
  const chat = new ChatGateway(auth, prisma);
  chat.server = { to: () => ({ emit: (event: string) => emitted.push(event) }), sockets: { sockets: new Map() } } as unknown as Server;
  const client = chatClient();
  const join = await chat.joinRoom(client, "room-1");
  assert.deepEqual(join, { ok: true, status: "READY" });
  assert.deepEqual(await chat.sendMessage(client, { roomId: "room-1", content: "老师好" }), { ok: false, message: "课堂未开播，暂不能发言" });
  assert.equal(created, 0);
  roomStatus = "LIVE";
  assert.deepEqual(await chat.sendMessage(client, { roomId: "room-1", content: "老师好" }), { ok: true });
  assert.equal(created, 1);
  assert.deepEqual(emitted, ["new-message"]);
});
