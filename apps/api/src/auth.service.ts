import { createHash, randomBytes, scrypt as scryptCallback, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";
import { EventEmitter } from "node:events";
import { BadRequestException, HttpException, Injectable, UnauthorizedException } from "@nestjs/common";
import type { Role } from "./generated/prisma/client.js";
import { PrismaService } from "./prisma.service.js";
import { withUserLock } from "./user-transaction.js";
import { AuditService } from "./audit.service.js";

const scrypt = promisify(scryptCallback);
const sessionDurationMs = 7 * 24 * 60 * 60 * 1000;

/** 会话验证结果（显式定义，避免 ReturnType 与短缓存字段互相推导成环）。 */
export type CurrentUser = {
  id: string;
  displayName: string;
  email: string;
  role: Role;
  isTest: boolean;
  mustChangePassword: boolean;
  sessionExpiresAt: string;
};

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16).toString("hex");
  const hash = (await scrypt(password, salt, 64)) as Buffer;
  return `${salt}:${hash.toString("hex")}`;
}

export async function matchesPassword(password: string, stored: string): Promise<boolean> {
  const [salt, expectedHex] = stored.split(":");
  if (!salt || !expectedHex) return false;
  const expected = Buffer.from(expectedHex, "hex");
  if (expected.length !== 64) return false;
  const actual = (await scrypt(password, salt, 64)) as Buffer;
  return timingSafeEqual(actual, expected);
}

export function tokenHash(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

@Injectable()
export class AuthService {
  readonly revokedSessions = new EventEmitter();
  // shortcut: 单进程登录限频，部署多实例前改为共享限频存储；生产反代另设 IP 限频。
  private readonly attempts = new Map<string, { count: number; until: number }>();
  // 会话短缓存：每个 HTTP 请求（含视频分片、图片等高频只读请求）都要验会话，5 秒 TTL 把重复的 session JOIN user 查询合并掉。
  // 吊销（退出/改密/停用/重置）通过 revokedSessions 事件即时清缓存，TTL 仅作兜底。
  private static readonly SESSION_CACHE_MS = 5_000;
  private readonly sessionCache = new Map<string, { value: CurrentUser; expiresAt: number }>();
  constructor(private readonly prisma: PrismaService, private readonly audit: AuditService) {
    this.revokedSessions.on("revoked", (hash: string) => this.sessionCache.delete(hash));
  }

  async login(email: string, password: string) {
    email = email.toLowerCase();
    const now = Date.now();
    for (const [key, entry] of this.attempts) if (entry.until <= now) this.attempts.delete(key);
    const attempt = this.attempts.get(email) ?? { count: 0, until: now + 15 * 60_000 };
    if (attempt.count >= 10 || (!this.attempts.has(email) && this.attempts.size >= 10_000)) {
      throw new HttpException("登录尝试过多，请 15 分钟后重试", 429);
    }
    attempt.count++;
    this.attempts.set(email, attempt);
    const user = await this.prisma.user.findUnique({ where: { email } });
    if (!user?.isActive || !(await matchesPassword(password, user.passwordHash))) {
      await this.audit.log({ action: "LOGIN_FAILED", detail: `账号 ${email} 登录失败`, actorName: email });
      throw new UnauthorizedException("账号或密码错误");
    }
    const token = randomBytes(32).toString("base64url");
    await withUserLock(this.prisma, user.id, async (tx) => {
      const current = await tx.user.findUnique({ where: { id: user.id } });
      if (current?.passwordHash !== user.passwordHash) throw new UnauthorizedException("密码已变更，请重新登录");
      await tx.session.create({
        data: { tokenHash: tokenHash(token), userId: user.id, expiresAt: new Date(Date.now() + sessionDurationMs) }
      });
    });
    this.attempts.delete(email);
    await this.audit.log({ action: "LOGIN", userId: user.id, actorName: user.displayName, detail: `${user.displayName}（${user.role}）登录成功` });
    return { token, user: { id: user.id, displayName: user.displayName, email: user.email, role: user.role, mustChangePassword: user.mustChangePassword } };
  }

  async userForToken(token: string | undefined): Promise<CurrentUser> {
    if (!token) throw new UnauthorizedException("请先登录");
    const hash = tokenHash(token);
    const cached = this.sessionCache.get(hash);
    if (cached && cached.expiresAt > Date.now()) return cached.value;
    const session = await this.prisma.session.findUnique({
      where: { tokenHash: hash }, include: { user: true }
    });
    if (!session || !session.user.isActive || session.expiresAt.getTime() <= Date.now()) throw new UnauthorizedException("登录已失效");
    const value: CurrentUser = {
      id: session.user.id,
      displayName: session.user.displayName,
      email: session.user.email,
      role: session.user.role,
      isTest: session.user.isTest,
      mustChangePassword: session.user.mustChangePassword,
      sessionExpiresAt: session.expiresAt.toISOString()
    };
    if (this.sessionCache.size > 10_000) this.sessionCache.clear(); // 防御性上限
    this.sessionCache.set(hash, { value, expiresAt: Date.now() + AuthService.SESSION_CACHE_MS });
    return value;
  }

  async changePassword(token: string | undefined, currentPassword: string, newPassword: string): Promise<void> {
    const user = await this.userForToken(token);
    if (newPassword.length < 12 || newPassword.length > 200 || newPassword === currentPassword) {
      throw new BadRequestException("新密码需至少 12 位，且不能与原密码相同");
    }
    const passwordHash = await hashPassword(newPassword);
    const revoked = await withUserLock(this.prisma, user.id, async (tx) => {
      const current = await tx.user.findUniqueOrThrow({ where: { id: user.id } });
      if (!(await matchesPassword(currentPassword, current.passwordHash))) throw new BadRequestException("原密码不正确");
      const sessions = await tx.session.findMany({ where: { userId: user.id }, select: { tokenHash: true } });
      await tx.user.update({ where: { id: user.id }, data: { passwordHash, mustChangePassword: false } });
      await tx.session.deleteMany({ where: { userId: user.id } });
      return sessions;
    });
    for (const session of revoked) this.revokedSessions.emit("revoked", session.tokenHash);
    await this.audit.log({ action: "PASSWORD_CHANGED", userId: user.id, actorName: user.displayName, detail: `${user.displayName} 修改了自己的密码` });
  }

  async logout(token: string | undefined): Promise<void> {
    if (token) {
      const user = await this.userForToken(token).catch(() => null);
      const hash = tokenHash(token);
      await this.prisma.session.deleteMany({ where: { tokenHash: hash } });
      this.revokedSessions.emit("revoked", hash);
      if (user) await this.audit.log({ action: "LOGOUT", userId: user.id, actorName: user.displayName, detail: `${user.displayName} 退出登录` });
    }
  }
}
