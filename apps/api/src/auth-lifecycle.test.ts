import "reflect-metadata";
import test from "node:test";
import assert from "node:assert/strict";
import { ForbiddenException, UnauthorizedException, type ExecutionContext } from "@nestjs/common";
import { AuthService, hashPassword } from "./auth.service.js";
import { AuthGuard } from "./auth.guard.js";
import type { PrismaService } from "./prisma.service.js";

test("停用账号不能登录，旧会话立即失效", async () => {
  const user = { id: "disabled", email: "disabled@test.local", passwordHash: await hashPassword("Password123456!"), isActive: false };
  const prisma = {
    user: { findUnique: async () => user },
    session: { create: async () => ({}), findUnique: async () => ({ user, expiresAt: new Date(Date.now() + 60_000) }) }
  } as unknown as PrismaService;
  const auth = new AuthService(prisma);
  await assert.rejects(auth.login(user.email, "Password123456!"), UnauthorizedException);
  await assert.rejects(auth.userForToken("old-session"), UnauthorizedException);
});

test("连续失败登录受到限频，避免无限尝试密码", async () => {
  let lookups = 0;
  const prisma = { user: { findUnique: async () => { lookups++; return null; } } } as unknown as PrismaService;
  const auth = new AuthService(prisma);
  for (let i = 0; i < 10; i++) await assert.rejects(auth.login("absent@test.local", "wrong-password"));
  await assert.rejects(auth.login("absent@test.local", "wrong-password"), /尝试过多/);
  assert.equal(lookups, 10);
});

test("首次登录未改密时不能访问业务接口", async () => {
  const auth = { userForToken: async () => ({ id: "first-login", role: "STUDENT", mustChangePassword: true }) } as unknown as AuthService;
  const request = { headers: { cookie: "sid=first-login" } };
  const context = { switchToHttp: () => ({ getRequest: () => request }) } as unknown as ExecutionContext;
  await assert.rejects(new AuthGuard(auth).canActivate(context), ForbiddenException);
});
