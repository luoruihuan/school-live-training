import { UnauthorizedException } from "@nestjs/common";
import type { Prisma } from "./generated/prisma/client.js";
import type { PrismaService } from "./prisma.service.js";

// 同一用户的购物车、结算和会话变更共用行锁，等待者读取最新已提交数据。
export function withUserLock<T>(prisma: PrismaService, userId: string, action: (tx: Prisma.TransactionClient) => Promise<T>) {
  return prisma.$transaction(async (tx) => {
    const users = await tx.$queryRaw<{ id: string; isActive: boolean }[]>`SELECT id, isActive FROM User WHERE id = ${userId} FOR UPDATE`;
    if (!users[0]?.isActive) throw new UnauthorizedException("账号已停用或不存在");
    return action(tx);
  }, { isolationLevel: "ReadCommitted" });
}
