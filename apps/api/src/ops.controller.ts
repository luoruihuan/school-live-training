import { connect } from "node:net";
import { Controller, ForbiddenException, Get, Query, Req, UseGuards } from "@nestjs/common";
import type { Request } from "express";
import { AuthGuard, requireSuperAdmin, type UserRequest } from "./auth.guard.js";
import { PrismaService } from "./prisma.service.js";
import { StorageService } from "./storage.service.js";

type Alert = { key: string; level: "ok" | "warn" | "danger"; title: string; message: string };

const VIEWER_WARN = 10;
const VIEWER_DANGER = 12;
const DISK_WARN = 75;
const DISK_DANGER = 85;

function tcpProbe(host: string, port: number, timeoutMs = 1500): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect({ host, port });
    const finish = (ok: boolean) => { socket.destroy(); resolve(ok); };
    socket.setTimeout(timeoutMs, () => finish(false));
    socket.once("connect", () => finish(true));
    socket.once("error", () => finish(false));
  });
}

@Controller("ops")
@UseGuards(AuthGuard)
export class OpsController {
  constructor(private readonly prisma: PrismaService, private readonly storage: StorageService) {}

  @Get("overview")
  async overview(@Req() request: UserRequest) {
    requireSuperAdmin(request.currentUser);
    void (request as Request);

    const [diskPercent, streams, mysqlOk, srsOk, minioOk] = await Promise.all([
      this.storage.diskUsagePercent(),
      this.liveStreams().catch(() => [] as { streamName: string; clients: number; kbps: number }[]),
      tcpProbe("mysql", 3306),
      tcpProbe("srs", 1985),
      tcpProbe("minio", 9000)
    ]);

    const dayStart = new Date(); dayStart.setHours(0, 0, 0, 0);
    const since30 = new Date(Date.now() - 30 * 86400_000);
    const [userTotal, todayLogins, activeSessions, recordingAgg, replayAgg, liveSeconds30] = await Promise.all([
      this.prisma.user.count({ where: { isActive: true } }),
      this.prisma.auditLog.count({ where: { action: "LOGIN", createdAt: { gte: dayStart } } }),
      this.prisma.session.count({ where: { expiresAt: { gt: new Date() } } }),
      this.prisma.recording.aggregate({ _sum: { sizeMb: true }, _count: true }),
      this.prisma.recording.aggregate({ where: { createdAt: { gte: since30 } }, _sum: { sizeMb: true } }),
      this.prisma.room.aggregate({ _sum: { liveSecondsTotal: true } })
    ]);

    const diskFreeGb = await this.diskFreeGb();
    const monthlyGrowthMb = replayAgg._sum.sizeMb ?? 0;
    const viewers = streams.reduce((sum, stream) => sum + stream.clients, 0);

    const alerts: Alert[] = [
      viewers >= VIEWER_DANGER
        ? { key: "viewers", level: "danger", title: `当前 ${viewers} 路同时观看，已到带宽上限`, message: "30Mbps 带宽按 2.5Mbps 码率最多支撑约 12 路流畅观看。请立即让教师把 OBS 码率降到 1.2~1.5Mbps（可撑约 20~24 路），或升级服务器带宽。" }
        : viewers >= VIEWER_WARN
          ? { key: "viewers", level: "warn", title: `当前 ${viewers} 路同时观看，接近带宽上限（约 12 路）`, message: "建议教师把 OBS 码率控制在 2Mbps 以内；若观看人数还将增长，提前规划升级带宽。" }
          : { key: "viewers", level: "ok", title: `当前 ${viewers} 路观看，带宽余量充足`, message: "30Mbps 带宽约支撑 12 路（2.5Mbps 码率）流畅观看，当前无压力。" },
      diskPercent === null
        ? { key: "disk", level: "warn", title: "磁盘使用率读取失败", message: "API 容器无法读取数据卷所在文件系统，请人工检查。" }
        : diskPercent >= DISK_DANGER
          ? { key: "disk", level: "danger", title: `磁盘已用 ${diskPercent}%，超过 ${DISK_DANGER}% 高水位线`, message: "水位清理已在自动删除最旧回放（最少保留 90 天）。如需保留更久，请挂载弹性云盘或升级套餐。" }
          : diskPercent >= DISK_WARN
            ? { key: "disk", level: "warn", title: `磁盘已用 ${diskPercent}%，接近 ${DISK_DANGER}% 高水位线`, message: "建议尽快规划挂载弹性云盘，避免触发自动清理。" }
            : { key: "disk", level: "ok", title: `磁盘已用 ${diskPercent}%`, message: `剩余约 ${diskFreeGb?.toFixed(1) ?? "—"} GB，余量充足。` },
      monthlyGrowthMb <= 0
        ? { key: "storage", level: "ok", title: "近 30 天无新增回放", message: "回放存储暂无增长压力。" }
        : (() => {
            const monthlyGb = monthlyGrowthMb / 1024;
            const monthsLeft = diskFreeGb !== null ? diskFreeGb / Math.max(monthlyGb, 0.01) : null;
            return monthsLeft !== null && monthsLeft < 1.5
              ? { key: "storage", level: "danger", title: `按近 30 天新增 ${monthlyGb.toFixed(1)}GB 估算，剩余空间仅够约 ${Math.max(monthsLeft, 0).toFixed(1)} 个月`, message: "请立即挂载弹性云盘或收紧回放保留期（RECORDING_RETENTION_DAYS）。" }
              : monthsLeft !== null && monthsLeft < 3
                ? { key: "storage", level: "warn", title: `近 30 天新增回放 ${monthlyGb.toFixed(1)}GB，剩余空间约可再存 ${monthsLeft.toFixed(1)} 个月`, message: "建议本月内完成云盘扩容规划。" }
                : { key: "storage", level: "ok", title: `近 30 天新增回放 ${monthlyGb.toFixed(1)}GB`, message: monthsLeft !== null ? `按此增速剩余空间约可存 ${monthsLeft.toFixed(1)} 个月，暂无压力。` : "" };
          })()
    ];

    return {
      server: {
        diskPercent,
        diskFreeGb,
        recordingTotalMb: recordingAgg._sum.sizeMb ?? 0,
        recordingCount: recordingAgg._count,
        liveSecondsTotal: liveSeconds30._sum.liveSecondsTotal ?? 0
      },
      streams,
      viewers,
      services: [
        { name: "直播服务 SRS", ok: srsOk },
        { name: "对象存储 MinIO", ok: minioOk },
        { name: "数据库 MySQL", ok: mysqlOk }
      ],
      users: { total: userTotal, todayLogins, activeSessions },
      alerts
    };
  }

  @Get("audit-logs")
  async auditLogs(@Req() request: UserRequest, @Query() query: Record<string, unknown>) {
    requireSuperAdmin(request.currentUser);
    const page = query.page === undefined ? 1 : Number(query.page);
    if (!Number.isSafeInteger(page) || page < 1 || page > 100_000) throw new ForbiddenException("页码不正确");
    const action = typeof query.action === "string" && /^[A-Z_]{2,40}$/.test(query.action) ? query.action : undefined;
    const where = action ? { action } : {};
    const [items, total, actions] = await this.prisma.$transaction([
      this.prisma.auditLog.findMany({ where, orderBy: { createdAt: "desc" }, skip: (page - 1) * 20, take: 20 }),
      this.prisma.auditLog.count({ where }),
      this.prisma.auditLog.groupBy({ by: ["action"], _count: true, orderBy: { _count: { action: "desc" } } })
    ]);
    return { items, total, page, pageSize: 20, actions: actions.map((row) => ({ action: row.action, count: row._count })) };
  }

  private async liveStreams(): Promise<{ streamName: string; clients: number; kbps: number }[]> {
    const response = await fetch("http://srs:1985/api/v1/streams", { signal: AbortSignal.timeout(3000) });
    if (!response.ok) return [];
    const data = await response.json() as { streams?: { name?: string; clients?: unknown[]; kbps?: { send?: number; video?: number; audio?: number } }[] };
    return (data.streams ?? []).map((stream) => ({
      streamName: stream.name ?? "",
      clients: Array.isArray(stream.clients) ? stream.clients.length : 0,
      kbps: Math.round((stream.kbps?.send ?? 0) / 1000)
    })).filter((stream) => stream.streamName);
  }

  private async diskFreeGb(): Promise<number | null> {
    try {
      const stats = await import("node:fs/promises").then((fs) => fs.statfs("/var/srs-recordings"));
      if (!stats.blocks) return null;
      return Math.round((stats.bavail * stats.bsize) / 1024 / 1024 / 1024 * 10) / 10;
    } catch {
      return null;
    }
  }
}
