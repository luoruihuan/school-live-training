import { connect } from "node:net";
import { readFile } from "node:fs/promises";
import { BadRequestException, Body, Controller, ForbiddenException, Get, Patch, Post, Query, Req, UseGuards } from "@nestjs/common";
import { AuthGuard, requireSuperAdmin, type UserRequest } from "./auth.guard.js";
import { object } from "./input.js";
import { PrismaService } from "./prisma.service.js";
import { StorageService } from "./storage.service.js";
import { AuditActions, AuditService, type AuditAction } from "./audit.service.js";
import { AlertService } from "./alert.service.js";
import { ChatGateway } from "./chat.gateway.js";
import { cdnLiveDomain, recordingRetentionDays, replayCdnDomain, REPLAY_URL_TTL_SECONDS } from "./cloud-config.js";
import { CDN_LIVE_SWITCH, REPLAY_CDN_SWITCH, cdnSwitches } from "./system-settings.js";
import { cssConfig, cssSetupError } from "./css-config.js";
import { changeLiveProvider, readLiveRoute } from "./live-route.js";
import { beijingDayStart, groupLiveSessions } from "./live-sessions.js";

type AlertLevel = "warn" | "danger";
type Alert = { key: string; level: AlertLevel; title: string; message: string };
type ServiceStatus = "ok" | "down" | "unconfigured" | "unknown";
type Service = { key: string; name: string; detail: string; status: ServiceStatus };
type StreamRow = { streamName: string; clients: number; kbps: number; kbpsRecv: number };

const DISK_WARN = 75;
const DISK_DANGER = 85;
// 自建线路源站出口为 5 Mbps（上海机带宽上限）：空闲 >3 或直播中 >4 视为异常
const EGRESS_IDLE_DANGER = 3;
const EGRESS_LIVE_WARN = 4;
// 自建线路下学生直接拉原始流，码率过高会卡；阈值与教师端提示一致。腾讯云线路由自适应码率兜底，不再按码率告警。
const SRS_BITRATE_WARN = 4500;
const RECONNECTS_WARN = 3;
const LOGIN_FAILURES_WARN = 5;
const CONSOLE_BILL_URL = "https://console.cloud.tencent.com/live/analysis/bill";
const TODAY_ACTIONS = ["PUBLISH_START", "PUBLISH_STOP", "RECORDING_SAVED", "LOGIN", "LOGIN_FAILED", "REPLAY_PLAYED"] as const satisfies readonly AuditAction[];

function tcpProbe(host: string, port: number, timeoutMs = 1500): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect({ host, port });
    const finish = (ok: boolean) => { socket.destroy(); resolve(ok); };
    socket.setTimeout(timeoutMs, () => finish(false));
    socket.once("connect", () => finish(true));
    socket.once("error", () => finish(false));
  });
}

/** 播放域名可达性：只要拿到任意 HTTP 响应（含 403/404）就说明 DNS、证书和 CDN 边缘正常。 */
async function httpsReachable(url: string, timeoutMs = 5000): Promise<boolean> {
  try {
    await fetch(url, { method: "HEAD", redirect: "manual", signal: AbortSignal.timeout(timeoutMs) });
    return true;
  } catch {
    return false;
  }
}

function beijingTime(date: Date): string {
  return date.toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit", hour12: false, timeZone: "Asia/Shanghai" });
}

@Controller("ops")
@UseGuards(AuthGuard)
export class OpsController {
  constructor(private readonly prisma: PrismaService, private readonly storage: StorageService, private readonly audit: AuditService, private readonly chat: ChatGateway, private readonly alert: AlertService) {}

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
    const abrTemplate = cssError ? "" : cssConfig().abrTemplate;
    return {
      liveProvider: {
        value: route.provider, cssConfigured: !cssError, cssError,
        abr: { enabled: !!abrTemplate, template: abrTemplate || null }
      },
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

  /** 设置页用的轻量状态：有课堂在播时禁止切线路。 */
  @Get("live-status")
  async liveStatus(@Req() request: UserRequest) {
    requireSuperAdmin(request.currentUser);
    const [{ provider }, live] = await Promise.all([readLiveRoute(this.prisma), this.prisma.room.count({ where: { status: "LIVE" } })]);
    return { provider, active: live > 0 };
  }

  /** 发送一条测试告警，用来确认飞书机器人通道可用。 */
  @Post("alert-test")
  async testAlert(@Req() request: UserRequest) {
    requireSuperAdmin(request.currentUser);
    if (!this.alert.configured) throw new BadRequestException("未配置 FEISHU_WEBHOOK_URL，告警通道不可用");
    await this.alert.send(`[测试] 运维告警通道测试，由 ${request.currentUser.displayName} 触发。收到这条消息说明通道正常。`);
    await this.audit.log({ action: AuditActions.ALERT_TEST, actorName: request.currentUser.displayName, request, detail: `${request.currentUser.displayName} 发送了一条测试告警` });
    return this.alert.status();
  }

  @Get("overview")
  async overview(@Req() request: UserRequest) {
    requireSuperAdmin(request.currentUser);
    const now = new Date();
    const dayStart = beijingDayStart(now);
    const since30 = new Date(now.getTime() - 30 * 86400_000);
    const provider = (await readLiveRoute(this.prisma)).provider;
    const store = this.storage.recordingsStore();
    const cssError = cssSetupError();
    const playDomain = cssError ? null : cssConfig().playDomain;

    const [streams, egress, diskPercent, diskFreeGb, webOk, mysqlOk, minioOk, srsOk, recordingsOk, playReachable, liveRooms, todayRows, recordingAgg, growthAgg] = await Promise.all([
      provider === "SRS" ? this.liveStreams().catch(() => [] as StreamRow[]) : Promise.resolve([] as StreamRow[]),
      this.egressMbps(),
      this.storage.diskUsagePercent(),
      this.diskFreeGb(),
      tcpProbe("web", 80),
      tcpProbe("mysql", 3306),
      tcpProbe("minio", 9000),
      provider === "SRS" ? tcpProbe("srs", 1985) : Promise.resolve(false),
      store.store === "COS" ? this.storage.recordingsReachable() : Promise.resolve(true),
      playDomain ? httpsReachable(`https://${playDomain}/`) : Promise.resolve(false),
      this.prisma.room.findMany({ where: { status: "LIVE" }, select: { title: true, lastPublishAt: true } }),
      this.prisma.auditLog.findMany({ where: { createdAt: { gte: dayStart }, action: { in: [...TODAY_ACTIONS] } }, select: { action: true, detail: true, createdAt: true } }),
      this.prisma.recording.aggregate({ _sum: { sizeMb: true }, _count: true }),
      this.prisma.recording.aggregate({ where: { createdAt: { gte: since30 } }, _sum: { sizeMb: true } })
    ]);

    const sessions = groupLiveSessions(todayRows, now);
    const todayLogins = todayRows.filter((row) => row.action === "LOGIN").length;
    const todayLoginFailures = todayRows.filter((row) => row.action === "LOGIN_FAILED").length;
    const replayViewsToday = todayRows.filter((row) => row.action === "REPLAY_PLAYED").length;
    const recordingsTotalMb = recordingAgg._sum.sizeMb ?? 0;
    const growth30dMb = growthAgg._sum.sizeMb ?? 0;

    const services: Service[] = [
      { key: "api", name: "接口服务 API", detail: "本页数据来源，能打开即正常", status: "ok" },
      { key: "web", name: "网页服务 Web", detail: "管理端与学生端页面", status: webOk ? "ok" : "down" },
      { key: "mysql", name: "数据库 MySQL", detail: "账号、课堂与积分流水", status: mysqlOk ? "ok" : "down" },
      provider === "CSS"
        ? (cssError
          ? { key: "live", name: "直播服务 腾讯云 CSS", detail: cssError, status: "unconfigured" as const }
          : { key: "live", name: "直播服务 腾讯云 CSS", detail: `播放域名 ${playDomain}`, status: playReachable ? "ok" as const : "down" as const })
        : { key: "live", name: "直播服务 SRS（上海自建）", detail: "自建源站", status: srsOk ? "ok" as const : "down" as const },
      { key: "images", name: store.store === "COS" ? "图片存储 MinIO" : "存储 MinIO", detail: store.store === "COS" ? "商品图片" : "商品图片与回放", status: minioOk ? "ok" as const : "down" as const }
    ];
    if (store.store === "COS") services.push({ key: "recordings", name: "回放存储 COS", detail: store.target, status: recordingsOk ? "ok" : "down" });
    const channel = this.alert.status();
    services.push({
      key: "alert", name: "告警通道 飞书机器人",
      detail: !channel.configured ? "未配置 FEISHU_WEBHOOK_URL" : channel.last ? `最近发送 ${beijingTime(channel.last.at)} ${channel.last.ok ? "成功" : "失败"}` : "启动后尚未发送过",
      status: !channel.configured ? "unconfigured" : channel.last ? (channel.last.ok ? "ok" : "down") : "unknown"
    });

    const alerts: Alert[] = [];
    const down = services.filter((service) => service.status === "down");
    if (down.length) alerts.push({
      key: "services", level: "danger",
      title: `${down.length} 项服务不可达：${down.map((service) => service.name).join("、")}`,
      message: "学生端可能无法观看、图片或回放加载失败。请先检查对应容器，腾讯云相关项请到云直播控制台确认域名与配置。"
    });
    for (const session of sessions.filter((item) => item.recordingMissing)) alerts.push({
      key: `recording-${session.title}`, level: "danger",
      title: `课堂「${session.title}」已关播，回放未入库`,
      message: "关播超过 10 分钟仍没有收到录制回调。请到腾讯云控制台确认录制模板仍绑定在推流域名，并检查 COS 桶里是否有文件。"
    });
    for (const session of sessions.filter((item) => item.reconnects >= RECONNECTS_WARN)) alerts.push({
      key: `reconnects-${session.title}`, level: "warn",
      title: `课堂「${session.title}」直播中断重连 ${session.reconnects} 次`,
      message: "推流反复断开通常是教师上行网络不稳。请提醒教师检查网络，并把 OBS 码率降到 1080p 4000 或 720p 2000 Kbps。"
    });
    if (todayLoginFailures >= LOGIN_FAILURES_WARN) alerts.push({
      key: "logins", level: "warn", title: `今日登录失败 ${todayLoginFailures} 次`,
      message: "请留意是否有账号被反复尝试，必要时在账号管理里停用或重置密码。"
    });
    if (channel.configured && channel.last && !channel.last.ok) alerts.push({
      key: "alert-channel", level: "warn", title: "告警通道最近一次发送失败",
      message: `飞书机器人返回：${channel.last.error ?? "未知错误"}。出现异常时将收不到通知，请检查 FEISHU_WEBHOOK_URL。`
    });
    for (const stream of streams.filter((item) => item.kbpsRecv > SRS_BITRATE_WARN)) alerts.push({
      key: `bitrate-${stream.streamName}`, level: "warn",
      title: `推流码率偏高（${stream.kbpsRecv} Kbps）`,
      message: "自建线路下学生直接拉原始流，码率过高会卡。请在 OBS 设置 → 输出里把码率降到 1080p 4000 或 720p 2000 Kbps。"
    });
    if (provider === "SRS" && streams.length === 0 && egress > EGRESS_IDLE_DANGER) alerts.push({
      key: "egress-idle", level: "danger", title: `当前无直播，但服务器出口流量 ${egress} Mbps`,
      message: "CDN 模式下空闲时出口应接近 0。请检查是否有观众在直连源站，或是否有异常流量消耗带宽。"
    });
    if (provider === "SRS" && streams.length > 0 && egress > EGRESS_LIVE_WARN) alerts.push({
      key: "egress-live", level: "warn", title: `直播中出口流量 ${egress} Mbps，接近 5 Mbps 带宽上限`,
      message: "出口约等于回源路数乘以码率。偏高说明 CDN 回源路数多或存在直连，请检查 CDN 开关与观众分布。"
    });
    if (diskPercent === null) alerts.push({
      key: "disk", level: "warn", title: "本地磁盘使用率读取失败",
      message: "API 容器无法读取数据卷所在文件系统，请人工检查。"
    });
    else if (diskPercent >= DISK_DANGER) alerts.push({
      key: "disk", level: "danger", title: `服务器本地磁盘已用 ${diskPercent}%，超过 ${DISK_DANGER}% 高水位线`,
      message: "本地盘存放数据库与系统文件，回放存储不占此盘。请检查 Docker 镜像、容器日志或数据库占用，必要时扩容云盘。"
    });
    else if (diskPercent >= DISK_WARN) alerts.push({
      key: "disk", level: "warn", title: `服务器本地磁盘已用 ${diskPercent}%，接近 ${DISK_DANGER}% 高水位线`,
      message: "建议尽快排查占用或规划扩容，避免影响数据库写入。"
    });
    // 回放存放在本机 MinIO 时才会挤占本地盘；在 COS 上按量计费，没有容量压力。
    if (store.store === "MinIO" && growth30dMb > 0 && diskFreeGb !== null) {
      const monthlyGb = growth30dMb / 1024;
      const monthsLeft = diskFreeGb / Math.max(monthlyGb, 0.01);
      if (monthsLeft < 1.5) alerts.push({
        key: "storage", level: "danger", title: `回放存放在本机，按近 30 天新增 ${monthlyGb.toFixed(1)} GB 估算，剩余空间仅够约 ${Math.max(monthsLeft, 0).toFixed(1)} 个月`,
        message: "请把回放长期层切到 COS（配置 COS_*），或收紧回放保留期（RECORDING_RETENTION_DAYS）。"
      });
      else if (monthsLeft < 3) alerts.push({
        key: "storage", level: "warn", title: `回放存放在本机，近 30 天新增 ${monthlyGb.toFixed(1)} GB，剩余空间约可再存 ${monthsLeft.toFixed(1)} 个月`,
        message: "建议把回放长期层切到 COS，或规划云盘扩容。"
      });
    }

    const startedAt = liveRooms.reduce<Date | null>((latest, room) => room.lastPublishAt && (!latest || room.lastPublishAt > latest) ? room.lastPublishAt : latest, null);
    return {
      live: {
        provider,
        active: liveRooms.length > 0,
        title: liveRooms.length === 1 ? liveRooms[0].title : liveRooms.length > 1 ? `${liveRooms.length} 个课堂` : null,
        startedAt: startedAt?.toISOString() ?? null,
        streams
      },
      metrics: {
        online: this.chat.onlineConnections(),
        todayLogins, todayLoginFailures, replayViewsToday,
        sessionCount: sessions.length,
        liveSeconds: sessions.reduce((sum, session) => sum + session.seconds, 0),
        todayRecordings: sessions.reduce((sum, session) => sum + session.recordings, 0),
        recordingsMissing: sessions.filter((session) => session.recordingMissing).length,
        recordingsTotalMb, recordingsCount: recordingAgg._count, growth30dMb
      },
      services,
      resources: {
        recordings: { ...store, totalMb: recordingsTotalMb, count: recordingAgg._count, growth30dMb, retentionDays: recordingRetentionDays(), consoleUrl: provider === "CSS" || store.store === "COS" ? CONSOLE_BILL_URL : null },
        server: { diskPercent, diskFreeGb, egressMbps: egress }
      },
      sessions: sessions.map((session) => ({ ...session, startedAt: session.startedAt.toISOString(), endedAt: session.endedAt?.toISOString() ?? null })),
      alerts
    };
  }

  @Get("audit-logs")
  async auditLogs(@Req() request: UserRequest, @Query() query: Record<string, unknown>) {
    requireSuperAdmin(request.currentUser);
    const page = query.page === undefined ? 1 : Number(query.page);
    if (!Number.isSafeInteger(page) || page < 1 || page > 100_000) throw new ForbiddenException("页码不正确");
    const pageSize = query.pageSize === undefined ? 20 : Number(query.pageSize);
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

  private async liveStreams(): Promise<StreamRow[]> {
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
