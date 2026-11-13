import { connect } from "node:net";
import { BadRequestException, Body, Controller, ForbiddenException, Get, Patch, Query, Req, UseGuards } from "@nestjs/common";
import type { Request } from "express";
import { AuthGuard, requireSuperAdmin, type UserRequest } from "./auth.guard.js";
import { object } from "./input.js";
import { PrismaService } from "./prisma.service.js";
import { StorageService } from "./storage.service.js";
import { AuditService } from "./audit.service.js";
import { cdnLiveDomain, replayCdnDomain } from "./cloud-config.js";
import { CDN_LIVE_SWITCH, REPLAY_CDN_SWITCH, cdnSwitches } from "./system-settings.js";

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
  constructor(private readonly prisma: PrismaService, private readonly storage: StorageService, private readonly audit: AuditService) {}

  /** 单个 CDN 能力项的当前状态：开关值 + 环境变量是否已配置（含格式错误原因）。 */
  private cdnStatus(enabled: boolean, reader: () => string | undefined, envName: string) {
    try {
      const domain = reader();
      return { enabled, configured: !!domain, domain: domain ?? null, error: null as string | null };
    } catch (error) {
      return { enabled: false, configured: false, domain: null, error: `${envName} 配置不合法：${error instanceof Error ? error.message : String(error)}` };
    }
  }

  @Get("settings")
  async settings(@Req() request: UserRequest) {
    requireSuperAdmin(request.currentUser);
    const switches = await cdnSwitches(this.prisma);
    return {
      cdnLive: this.cdnStatus(switches.live, cdnLiveDomain, "CDN_LIVE_DOMAIN"),
      replayCdn: this.cdnStatus(switches.replay, replayCdnDomain, "REPLAY_CDN_DOMAIN")
    };
  }

  @Patch("settings")
  async updateSettings(@Req() request: UserRequest, @Body() body: unknown) {
    requireSuperAdmin(request.currentUser);
    const input = object(body);
    const next: { key: string; value: "true" | "false" }[] = [];
    const before = await cdnSwitches(this.prisma);
    for (const [field, switchKey, reader, envName] of [
      ["cdnLiveEnabled", CDN_LIVE_SWITCH, cdnLiveDomain, "CDN_LIVE_DOMAIN"],
      ["replayCdnEnabled", REPLAY_CDN_SWITCH, replayCdnDomain, "REPLAY_CDN_DOMAIN"]
    ] as const) {
      const value = input[field];
      if (value === undefined) continue;
      if (typeof value !== "boolean") throw new BadRequestException("开关参数不正确");
      if (value) {
        const status = this.cdnStatus(false, reader, envName);
        if (!status.configured) throw new BadRequestException(status.error ?? `请先在服务器配置 ${envName} 后再开启`);
      }
      next.push({ key: switchKey, value: value ? "true" : "false" });
    }
    if (!next.length) throw new BadRequestException("没有需要更新的设置");
    for (const item of next) {
      await this.prisma.systemSetting.upsert({ where: { key: item.key }, update: { value: item.value }, create: item });
    }
    const after = await cdnSwitches(this.prisma);
    await this.audit.log({
      action: "CDN_SWITCH", actorName: request.currentUser.displayName, request,
      detail: `${request.currentUser.displayName} 切换 CDN 分发：直播 ${before.live ? "开" : "关"}→${after.live ? "开" : "关"}，回放 ${before.replay ? "开" : "关"}→${after.replay ? "开" : "关"}`
    });
    return this.settings(request);
  }

  @Get("overview")
  async overview(@Req() request: UserRequest) {
    requireSuperAdmin(request.currentUser);
    void (request as Request);

    const [diskPercent, streams, mysqlOk, srsOk, minioOk] = await Promise.all([
      this.storage.diskUsagePercent(),
      this.liveStreams().catch(() => [] as { streamName: string; clients: number; kbps: number; kbpsRecv: number }[]),
      tcpProbe("mysql", 3306),
      tcpProbe("srs", 1985),
      tcpProbe("minio", 9000)
    ]);

    const dayStart = new Date(); dayStart.setHours(0, 0, 0, 0);
    const since30 = new Date(Date.now() - 30 * 86400_000);
    const [userTotal, todayLogins, activeSessions, recordingAgg, replayAgg, liveSeconds30, liveRooms] = await Promise.all([
      this.prisma.user.count({ where: { isActive: true } }),
      this.prisma.auditLog.count({ where: { action: "LOGIN", createdAt: { gte: dayStart } } }),
      this.prisma.session.count({ where: { expiresAt: { gt: new Date() } } }),
      this.prisma.recording.aggregate({ _sum: { sizeMb: true }, _count: true }),
      this.prisma.recording.aggregate({ where: { createdAt: { gte: since30 } }, _sum: { sizeMb: true } }),
      this.prisma.room.aggregate({ _sum: { liveSecondsTotal: true } }),
      this.prisma.room.findMany({ where: { status: "LIVE" }, select: { lastPublishAt: true } })
    ]);
    // 进行中的直播尚未结算入库（停播回调才累加 liveSecondsTotal），实时补足当前流的已推秒数。
    const ongoingSeconds = liveRooms.reduce((sum, room) => room.lastPublishAt ? sum + Math.max(0, Math.floor((Date.now() - room.lastPublishAt.getTime()) / 1000)) : sum, 0);

    const diskFreeGb = await this.diskFreeGb();
    const monthlyGrowthMb = replayAgg._sum.sizeMb ?? 0;
    const viewers = streams.reduce((sum, stream) => sum + stream.clients, 0);

    const alerts: Alert[] = [
      ...streams.filter((stream) => stream.kbpsRecv > 2200).map((stream) => ({
        key: `bitrate-${stream.streamName}`,
        level: "warn" as const,
        title: `推流码率偏高（${stream.kbpsRecv} kbps，建议 1200~1500）`,
        message: "请在 OBS 设置 → 输出 → 串流中把码率降到 1200~1500 Kbps：720p 教学画面足够清晰，存储与带宿耗直接减半，可支撑的观看路数也从约 10 路提升到约 18 路。"
      })),
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
        liveSecondsTotal: (liveSeconds30._sum.liveSecondsTotal ?? 0) + ongoingSeconds
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

  private async liveStreams(): Promise<{ streamName: string; clients: number; kbps: number; kbpsRecv: number }[]> {
    const response = await fetch("http://srs:1985/api/v1/streams", { signal: AbortSignal.timeout(3000) });
    if (!response.ok) return [];
    // SRS 6 的 clients 是连接数（含推流者），send_30s 是近 30 秒平均发送码率，recv_30s 是推流端上行码率（kbps）。
    const data = await response.json() as { streams?: { name?: string; clients?: number; kbps?: { send_30s?: number; recv_30s?: number } }[] };
    return (data.streams ?? []).map((stream) => ({
      streamName: stream.name ?? "",
      clients: Math.max(0, (typeof stream.clients === "number" ? stream.clients : 0) - 1),
      kbps: Math.round(stream.kbps?.send_30s ?? 0),
      kbpsRecv: Math.round(stream.kbps?.recv_30s ?? 0)
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
