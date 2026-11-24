import { randomBytes } from "node:crypto";
import { ConflictException } from "@nestjs/common";
import type { Prisma } from "./generated/prisma/client.js";
import type { PrismaService } from "./prisma.service.js";

export const LIVE_PROVIDER_KEY = "liveProvider";
export type LiveProvider = "SRS" | "CSS";
type LiveRoute = { provider: "SRS" } | { provider: "CSS"; version: string };

export async function readLiveRoute(prisma: Pick<PrismaService, "systemSetting">): Promise<LiveRoute> {
  const row = await prisma.systemSetting.findUnique({ where: { key: LIVE_PROVIDER_KEY } });
  return row && /^CSS:[a-f0-9]{32}$/.test(row.value)
    ? { provider: "CSS", version: row.value.slice(4) }
    : { provider: "SRS" };
}

// 线路切换、发推流码和推断流事件先锁同一行。锁内只做数据库操作，避免开播与切换交错。
export function withLiveRoute<T>(prisma: PrismaService, work: (tx: Prisma.TransactionClient, route: LiveRoute) => Promise<T>): Promise<T> {
  return prisma.$transaction(async (tx) => {
    await tx.$executeRaw`INSERT INTO \`SystemSetting\` (\`key\`, value, updatedAt) VALUES (${LIVE_PROVIDER_KEY}, 'SRS', CURRENT_TIMESTAMP(3)) ON DUPLICATE KEY UPDATE value = value`;
    return work(tx, await readLiveRoute(tx));
  });
}

export async function changeLiveProvider(prisma: PrismaService, provider: LiveProvider): Promise<LiveProvider> {
  return withLiveRoute(prisma, async (tx, current) => {
    if (current.provider === provider) return current.provider;
    if (await tx.room.findFirst({ where: { status: "LIVE" }, select: { id: true } })) {
      throw new ConflictException("有课堂正在直播，请停播后再切换线路");
    }
    const value = provider === "SRS" ? "SRS" : `CSS:${randomBytes(16).toString("hex")}`;
    await tx.systemSetting.update({ where: { key: LIVE_PROVIDER_KEY }, data: { value } });
    return current.provider;
  });
}
