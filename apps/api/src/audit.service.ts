import { Injectable, Logger } from "@nestjs/common";
import type { Request } from "express";
import { PrismaService } from "./prisma.service.js";

export const AuditActions = {
  LOGIN: "LOGIN",
  LOGIN_FAILED: "LOGIN_FAILED",
  LOGOUT: "LOGOUT",
  PASSWORD_CHANGED: "PASSWORD_CHANGED",
  PASSWORD_RESET: "PASSWORD_RESET",
  USER_CREATED: "USER_CREATED",
  USER_DISABLED: "USER_DISABLED",
  USER_ENABLED: "USER_ENABLED",
  POINTS_ADJUST: "POINTS_ADJUST",
  PUBLISH_START: "PUBLISH_START",
  PUBLISH_STOP: "PUBLISH_STOP",
  RECORDING_SAVED: "RECORDING_SAVED",
  REPLAY_PLAYED: "REPLAY_PLAYED",
  ORDER_COMPLETED: "ORDER_COMPLETED"
} as const;

export type AuditAction = typeof AuditActions[keyof typeof AuditActions];

function clientIp(request: Request | undefined): string | null {
  const forwarded = request?.headers["x-forwarded-for"];
  if (typeof forwarded === "string" && forwarded.trim()) return forwarded.split(",")[0]!.trim().slice(0, 45);
  return null;
}

@Injectable()
export class AuditService {
  private readonly logger = new Logger(AuditService.name);

  constructor(private readonly prisma: PrismaService) {}

  async log(input: { action: AuditAction; detail: string; userId?: string | null; actorName?: string; ip?: string | null; request?: Request }): Promise<void> {
    try {
      await this.prisma.auditLog.create({
        data: {
          action: input.action,
          detail: input.detail.slice(0, 500),
          userId: input.userId ?? null,
          actorName: (input.actorName ?? "系统").slice(0, 80),
          ip: input.ip ?? (input.request ? clientIp(input.request) : null)
        }
      });
    } catch (error) {
      this.logger.warn(`审计日志写入失败：${String(error)}`);
    }
  }
}
