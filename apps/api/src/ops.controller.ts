import { connect } from "node:net";
import { readFile } from "node:fs/promises";
import { BadRequestException, Body, Controller, ForbiddenException, Get, Patch, Query, Req, UseGuards } from "@nestjs/common";
import type { Request } from "express";
import { AuthGuard, requireSuperAdmin, type UserRequest } from "./auth.guard.js";
import { object } from "./input.js";
import { PrismaService } from "./prisma.service.js";
import { StorageService } from "./storage.service.js";
import { AuditService } from "./audit.service.js";
import { ChatGateway } from "./chat.gateway.js";
import { cdnLiveDomain, replayCdnDomain, REPLAY_URL_TTL_SECONDS } from "./cloud-config.js";
import { CDN_LIVE_SWITCH, REPLAY_CDN_SWITCH, cdnSwitches } from "./system-settings.js";
import { cssSetupError } from "./css-config.js";
import { changeLiveProvider, readLiveRoute } from "./live-route.js";

type Alert = { key: string; level: "ok" | "warn" | "danger"; title: string; message: string };

const DISK_WARN = 75;
const DISK_DANGER = 85;
// CDN 模式下服务器只出回源流量(上海机带宽上限 5Mbps):空闲>3 或直播中>4 视为异常
const EGRESS_IDLE_DANGER = 3;
const EGRESS_LIVE_WARN = 4;

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
  constructor(private readonly prisma: PrismaService, private readonly storage: StorageService, private readonly audit: AuditService, private readonly chat: ChatGateway) {}

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
    const [switches, route] = await Promise.all([cdnSwitches(this.prisma), readLiveRoute(this.prisma)]);
    const cssError = cssSetupError();
    return {
      liveProvider: { value: route.provider, cssConfigured: !cssError, cssError },
      cdnLive: this.cdnStatus(switches.live, cdnLiveDomain, "CDN_LIVE_DOMAIN"),
      replayCdn: {
        ...this.cdnStatus(switches.replay, replayCdnDomain, "REPLAY_CDN_DOMAIN"),
        // 面板展示用：提醒控制台 TypeA 有效时长需与此一致，否则观看中 seek 可能被 403
        expectedAuthTtlSeconds: REPLAY_URL_TTL_SECONDS
      }
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
    await this.prisma.$transaction(next.map((item) =>
      this.prisma.systemSetting.upsert({ where: { key: item.key }, update: { value: item.value }, create: item })
    ));
    const after = await cdnSwitches(this.prisma);
    await this.audit.log({
      action: "CDN_SWITCH", actorName: request.currentUser.displayName, request,
      detail: `${request.currentUser.displayName} 切换 CDN 分发：直播 ${before.live ? "开" : "关"}→${after.live ? "开" : "关"}，回放 ${before.replay ? "开" : "关"}→${after.replay ? "开" : "关"}`
    });
    return this.settings(request);
  }

  @Patch("live-provider")
  async updateLiveProvider(@Req() request: UserRequest, @Body() body: unknown) {
    requireSuperAdmin(request.currentUser);
    const provider = object(body).provider;
    if (provider !== "SRS" && provider !== "CSS") throw new BadRequestException("直播线路参数不正确");
    if (provider === "CSS") {
      const configError = cssSetupError();
      if (configError) throw new BadRequestException(configError);
    }
    const before = await changeLiveProvider(this.prisma, provider);
    if (before !== provider) await this.audit.log({
      action: "LIVE_PROVIDER_SWITCH", actorName: request.currentUser.displayName, request,
      detail: `${request.currentUser.displayName} 切换直播线路：${before} → ${provider}`
    });
    return this.settings(request);
  }

  @Get("overview")
  async overview(@Req() request: UserRequest) {
    requireSuperAdmin(request.currentUser);
    void (request as Request);

    const [diskPercent, streams, mysqlOk, srsOk, minioOk, { provider }] = await Promise.all([
      this.storage.diskUsagePercent(),
      this.liveStreams().catch(() => [] as { streamName: string; clients: number; kbps: number; kbpsRecv: number }[]),
      tcpProbe("mysql", 3306),
      tcpProbe("srs", 1985),
      tcpProbe("minio", 9000),
      readLiveRoute(this.prisma)
    ]);

    const dayStart = new Date(); dayStart.setHours(0, 0, 0, 0);
    const since30 = new Date(Date.now() - 30 * 86400_000);
    const [egress, userTotal, todayLogins, activeSessions, recordingAgg, replayAgg, liveSeconds30, liveRooms, todayPublishes, todayReplayViews, todayRecordingAgg] = await Promise.all([
      this.egressMbps(),
      this.prisma.user.count({ where: { isActive: true } }),
      this.prisma.auditLog.count({ where: { action: "LOGIN", createdAt: { gte: dayStart } } }),
      this.prisma.session.count({ where: { expiresAt: { gt: new Date() } } }),
      this.prisma.recording.aggregate({ _sum: { sizeMb: true }, _count: true }),
      this.prisma.recording.aggregate({ where: { createdAt: { gte: since30 } }, _sum: { sizeMb: true } }),
      this.prisma.room.aggregate({ _sum: { liveSecondsTotal: true } }),
      this.prisma.room.findMany({ where: { status: "LIVE" }, select: { lastPublishAt: true } }),
      this.prisma.auditLog.count({ where: { action: "PUBLISH_START", createdAt: { gte: dayStart } } }),
      this.prisma.auditLog.count({ where: { action: "REPLAY_PLAYED", createdAt: { gte: dayStart } } }),
      this.prisma.recording.aggregate({ where: { createdAt: { gte: dayStart } }, _sum: { sizeMb: true } })
    ]);
    // 进行中的直播尚未结算入库（停播回调才累加 liveSecondsTotal），实时补足当前流的已推秒数。
    const ongoingSeconds = liveRooms.reduce((sum, room) => room.lastPublishAt ? sum + Math.max(0, Math.floor((Date.now() - room.lastPublishAt.getTime()) / 1000)) : sum, 0);
    const todayRecordingMb = todayRecordingAgg._sum.sizeMb ?? 0;

    const diskFreeGb = await this.diskFreeGb();
    const monthlyGrowthMb = replayAgg._sum.sizeMb ?? 0;
    const viewers = streams.reduce((sum, stream) => sum + stream.clients, 0);

    const alerts: Alert[] = [
      ...streams.filter((stream) => stream.kbpsRecv > 2200).map((stream) => ({
        key: `bitrate-${stream.streamName}`,
        level: "warn" as const,
        title: `推流码率偏高（${stream.kbpsRecv} kbps，建议 1200~1500）`,
        message: "请在 OBS 设置 → 输出 → 串流中把码率降到 1200~1500 Kbps：观众走 CDN 不限路数，但码率直接决定 CDN 流量费与回放存储，降低可省一半以上成本。"
      })),
      ...provider === "SRS" && streams.length === 0 && egress > EGRESS_IDLE_DANGER
        ? [{ key: "egress-idle", level: "danger" as const, title: `当前无直播，但服务器出口流量 ${egress} Mbps`, message: "CDN 模式下空闲时出口应接近 0。请检查：是否有观众在直连源站（CDN 开关被关闭？）、是否有异常流量消耗带宽包。" }] : [],
      ...provider === "SRS" && streams.length > 0 && egress > EGRESS_LIVE_WARN
        ? [{ key: "egress-live", level: "warn" as const, title: `直播中出口流量 ${egress} Mbps，接近 5Mbps 带宽上限`, message: "出口≈回源路数×码率：观众集中时应在 1~3Mbps。偏高说明 CDN 回源路数多或存在直连，请检查 CDN 开关与观众分布。" }] : [],
      ...provider === "SRS" && streams.length > 0 && egress <= EGRESS_LIVE_WARN
        ? [{ key: "egress-live", level: "ok" as const, title: `直播中出口 ${egress} Mbps（回源正常，观众由 CDN 承载）`, message: "服务器只出回源流量，带宽上限 5Mbps，当前余量充足。" }] : [],
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
      live: {
        provider,
        active: provider === "CSS" ? liveRooms.length > 0 : streams.length > 0,
        streams,
        startedAt: liveRooms.reduce<Date | null>((latest, room) =>
          room.lastPublishAt && (!latest || room.lastPublishAt > latest) ? room.lastPublishAt : latest, null)?.toISOString() ?? null
      },
      online: this.chat.onlineConnections(),
      egressMbps: egress,
      today: {
        publishes: todayPublishes,
        replayViews: todayReplayViews,
        newRecordingMb: todayRecordingMb
      },
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
    const pageSize = query.pageSize === undefined ? 5 : Number(query.pageSize);
    if (!Number.isSafeInteger(pageSize) || pageSize < 1 || pageSize > 100) throw new ForbiddenException("每页条数不正确");
    const action = typeof query.action === "string" && /^[A-Z_]{2,40}$/.test(query.action) ? query.action : undefined;
    const where = action ? { action } : {};
    const [items, total, actions] = await this.prisma.$transaction([
      this.prisma.auditLog.findMany({ where, orderBy: { createdAt: "desc" }, skip: (page - 1) * pageSize, take: pageSize }),
      this.prisma.auditLog.count({ where }),
      this.prisma.auditLog.groupBy({ by: ["action"], _count: true, orderBy: { _count: { action: "desc" } } })
    ]);
    return { items, total, page, pageSize, actions: actions.map((row) => ({ action: row.action, count: row._count })) };
  }

  /** 服务器实时出口带宽(Mbps):读宿主机 /proc/net/dev(compose 只读挂载为 /host/proc/net/dev),两次采样求 TX 速率。 */
  private async egressMbps(): Promise<number> {
    const readTxBytes = async (): Promise<number | null> => {
      try {
        const text = await readFile("/host/proc/net/dev", "utf8");
        const line = text.split("\n").find((row: string) => row.trim().startsWith("eth0:"));
        if (!line) return null;
        const tx = Number(line.split(":")[1]?.trim().split(/\s+/)[8]);
        return Number.isFinite(tx) ? tx : null;
      } catch { return null; }
    };
    const first = await readTxBytes();
    if (first === null) return 0;
    await new Promise((resolve) => setTimeout(resolve, 1500));
    const second = await readTxBytes();
    if (second === null || second < first) return 0;
    return Math.round(((second - first) * 8 / 1.5 / 1_000_000) * 10) / 10;
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
