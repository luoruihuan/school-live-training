import { useCallback, useEffect, useState } from "react";
import { Alert, App, Button, Card, Col, Progress, Row, Select, Space, Spin, Switch, Table, Tag, Typography } from "antd";
import { ReloadOutlined } from "@ant-design/icons";
import { api, patch } from "./api";

type AlertItem = { key: string; level: "ok" | "warn" | "danger"; title: string; message: string };
type LiveProvider = "SRS" | "CSS";
type Overview = {
  live: { provider: LiveProvider; active: boolean; streams: { streamName: string; clients: number; kbps: number; kbpsRecv: number }[]; startedAt: string | null };
  online: number;
  egressMbps: number;
  today: { publishes: number; replayViews: number; newRecordingMb: number };
  server: { diskPercent: number | null; diskFreeGb: number | null; recordingTotalMb: number; recordingCount: number; liveSecondsTotal: number };
  streams: { streamName: string; clients: number; kbps: number; kbpsRecv: number }[];
  viewers: number;
  services: { name: string; ok: boolean }[];
  users: { total: number; todayLogins: number; activeSessions: number };
  alerts: AlertItem[];
};
type AuditRow = { id: string; actorName: string; action: string; detail: string; ip: string | null; createdAt: string };
type LogsPage = { items: AuditRow[]; total: number; page: number; pageSize: number; actions: { action: string; count: number }[] };
type CdnStatus = { enabled: boolean; configured: boolean; domain: string | null; error: string | null; expectedAuthTtlSeconds?: number };
type Settings = {
  liveProvider: { value: LiveProvider; cssConfigured: boolean; cssError: string | null };
  cdnLive: CdnStatus;
  replayCdn: CdnStatus;
};

const providerLabel: Record<LiveProvider, string> = { SRS: "上海自建（SRS）", CSS: "腾讯云标准直播（CSS）" };

const actionText: Record<string, string> = {
  LOGIN: "登录成功", LOGIN_FAILED: "登录失败", LOGOUT: "退出登录", PASSWORD_CHANGED: "修改密码", PASSWORD_RESET: "重置密码",
  USER_CREATED: "创建账号", USER_DISABLED: "停用账号", USER_ENABLED: "启用账号", POINTS_ADJUST: "积分调整",
  PUBLISH_START: "开始直播", PUBLISH_STOP: "结束直播", RECORDING_SAVED: "回放入库", REPLAY_PLAYED: "观看回放", PRODUCT_ADDED: "添加商品", PRODUCT_REMOVED: "移除商品", CDN_SWITCH: "CDN 切换", LIVE_PROVIDER_SWITCH: "直播线路切换", ORDER_COMPLETED: "订单完成"
};

const alertStyle = { ok: { type: "success" as const, color: "green" }, warn: { type: "warning" as const, color: "orange" }, danger: { type: "error" as const, color: "red" } };

export function OpsDashboard() {
  const { message } = App.useApp();
  const [overview, setOverview] = useState<Overview>();
  const [logs, setLogs] = useState<LogsPage>();
  const [settings, setSettings] = useState<Settings>();
  const [action, setAction] = useState<string | undefined>();
  const [page, setPage] = useState(1);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [switching, setSwitching] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true); setError("");
    try {
      const [data, logPage, config] = await Promise.all([
        api<Overview>("/ops/overview"),
        api<LogsPage>(`/ops/audit-logs?page=${page}&pageSize=5${action ? `&action=${action}` : ""}`),
        api<Settings>("/ops/settings")
      ]);
      setOverview(data); setLogs(logPage); setSettings(config);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "读取失败");
    } finally { setLoading(false); }
  }, [page, action]);

  useEffect(() => { void refresh(); }, [refresh]);

  async function toggleCdn(field: "cdnLiveEnabled" | "replayCdnEnabled", value: boolean, label: string): Promise<void> {
    setSwitching(field);
    try {
      setSettings(await patch<Settings>("/ops/settings", { [field]: value }));
      void message.success(value ? `${label}已开启：观众从 CDN 边缘节点拉流` : `${label}已关闭：回退直连源站`);
    } catch (reason) {
      void message.error(reason instanceof Error ? reason.message : "切换失败");
    } finally {
      setSwitching(null);
    }
  }

  async function selectLiveProvider(provider: LiveProvider): Promise<void> {
    setSwitching("liveProvider");
    try {
      setSettings(await patch<Settings>("/ops/live-provider", { provider }));
      void message.success(`已切换为${providerLabel[provider]}`);
      await refresh();
    } catch (reason) {
      void message.error(reason instanceof Error ? reason.message : "切换直播线路失败");
    } finally {
      setSwitching(null);
    }
  }

  return <Space direction="vertical" size="middle" style={{ width: "100%" }}>
    {error && <Alert type="error" showIcon title={error} action={<Button size="small" onClick={() => void refresh()}>重试</Button>} />}
    {loading && !overview ? <div style={{ padding: 80, textAlign: "center" }}><Spin size="large" /></div> : overview && <>
      <Row gutter={[12, 12]}>
        {overview.alerts.map((item) => (
          <Col xs={24} lg={8} key={item.key}>
            <Alert type={alertStyle[item.level].type} showIcon title={<Space><Tag color={alertStyle[item.level].color}>{item.level === "ok" ? "正常" : item.level === "warn" ? "注意" : "需处理"}</Tag>{item.title}</Space>} description={item.message} />
          </Col>
        ))}
      </Row>

      <Row gutter={[12, 12]}>
        <Col xs={12} md={6}><Card size="small" className="ops-stat">
          <div className="ops-stat__label">直播实况</div>
          <div className="ops-stat__value">{overview.live.active ? <span className="ops-stat__live">● 直播中</span> : "空闲"}</div>
          <div className="ops-stat__sub">{overview.live.active ? <>
            {overview.live.provider === "CSS" ? "由腾讯云 CSS 分发" : `${overview.live.streams[0]?.kbpsRecv ?? "—"} kbps · ${overview.viewers} 路`}
            {overview.live.startedAt ? ` · 已播 ${Math.max(0, Math.floor((Date.now() - new Date(overview.live.startedAt).getTime()) / 60000))} 分钟` : ""}
          </> : "当前没有正在进行的直播"}</div>
        </Card></Col>
        <Col xs={12} md={6}><Card size="small" className="ops-stat">
          <div className="ops-stat__label">当前在线</div>
          <div className="ops-stat__value">{overview.online} <small>人</small></div>
          <div className="ops-stat__sub">今日登录 {overview.users.todayLogins} 人</div>
        </Card></Col>
        <Col xs={12} md={6}><Card size="small" className="ops-stat">
          <div className="ops-stat__label">出口带宽(实时)</div>
          <div className="ops-stat__value" style={overview.egressMbps > 4 ? { color: "#cf1322" } : overview.egressMbps > 3 ? { color: "#faad14" } : undefined}>{overview.egressMbps} <small>Mbps</small></div>
          <div className="ops-stat__sub">{overview.live.provider === "CSS" ? "应用服务器公网出口" : overview.live.active ? "观众由 CDN 承载，此为回源流量" : "空闲时应接近 0"}</div>
        </Card></Col>
        <Col xs={12} md={6}><Card size="small" className="ops-stat">
          <div className="ops-stat__label">今日运营</div>
          <div className="ops-stat__value">开播 {overview.today.publishes} <small>场</small></div>
          <div className="ops-stat__sub">回放被看 {overview.today.replayViews} 次 · 新增录像 {overview.today.newRecordingMb}MB</div>
        </Card></Col>
      </Row>

      <Row gutter={[12, 12]}>
        <Col xs={24} md={12}>
          <Card title="磁盘使用" extra={overview.server.diskFreeGb !== null ? <Typography.Text type="secondary">剩余 {overview.server.diskFreeGb} GB</Typography.Text> : null}>
            <Progress percent={overview.server.diskPercent ?? 0} status={(overview.server.diskPercent ?? 0) >= 85 ? "exception" : (overview.server.diskPercent ?? 0) >= 75 ? "active" : "normal"} strokeColor={(overview.server.diskPercent ?? 0) >= 85 ? "#cf1322" : (overview.server.diskPercent ?? 0) >= 75 ? "#faad14" : undefined} />
            <Typography.Paragraph type="secondary" style={{ marginBottom: 0, marginTop: 8 }}>黄色 75% 提醒 · 红色 85% 触发自动清理最旧回放（最少保留 90 天）</Typography.Paragraph>
          </Card>
        </Col>
        <Col xs={24} md={12}>
          <Card title="服务状态">
            <Space wrap>{overview.services.map((service) => <Tag key={service.name} color={service.ok ? "green" : "red"}>{service.ok ? "●" : "○"} {service.name}</Tag>)}</Space>
            <Typography.Paragraph type="secondary" style={{ marginBottom: 0, marginTop: 12 }}>
              {overview.live.provider === "CSS" ? "在腾讯云云直播控制台查看 CSS 推流数据。" : overview.streams.length ? overview.streams.map((stream) => `${stream.streamName.slice(-6)}（${stream.clients} 路 · 推流 ${stream.kbpsRecv} kbps）`).join("；") : "当前没有正在进行的直播"}
            </Typography.Paragraph>
          </Card>
        </Col>
        <Col xs={24} md={12}>
          <Card title="直播线路">
            {settings ? <Space direction="vertical" size={8} style={{ width: "100%" }}>
              <Select aria-label="直播线路" value={settings.liveProvider.value} loading={switching === "liveProvider"}
                disabled={switching !== null || overview.live.active} style={{ width: "100%" }}
                options={([
                  { value: "SRS", label: providerLabel.SRS },
                  { value: "CSS", label: providerLabel.CSS, disabled: !settings.liveProvider.cssConfigured }
                ] satisfies { value: LiveProvider; label: string; disabled?: boolean }[])}
                onChange={(provider) => void selectLiveProvider(provider)} />
              <Typography.Text type="secondary">{overview.live.active ? "有课堂正在直播，停播后可切换。" : "切换后，请教师开播前重新获取 OBS 设置。"}</Typography.Text>
              {settings.liveProvider.cssError && <Typography.Text type="secondary">{settings.liveProvider.cssError}</Typography.Text>}
            </Space> : <Spin />}
          </Card>
        </Col>
        <Col xs={24} md={12}>
          <Card title="CDN 分发开关" extra={overview.live.provider === "SRS" ? <Typography.Text type={overview.viewers >= 10 ? "danger" : "secondary"}>当前 {overview.viewers} 路观看{overview.viewers >= 10 ? "，建议开启" : ""}</Typography.Text> : null}>
            {settings ? <Space direction="vertical" size={8} style={{ width: "100%" }}>
              {([
                { key: "cdnLive" as const, label: "上海自建直播走 CDN", field: "cdnLiveEnabled" as const, hint: "仅用于上海自建线路，观众从 CDN 拉流" },
                { key: "replayCdn" as const, label: "回放走 CDN", field: "replayCdnEnabled" as const, hint: "回放直连 COS 加速域名，不再经服务器代理" }
              ]).map(({ key, label, field, hint }) => {
                const status = settings[key];
                return <div key={field} className="cdn-switch-row">
                  <div className="cdn-switch-row__head"><Typography.Text strong={status.enabled}>{label}</Typography.Text><Switch size="small" loading={switching === field} disabled={switching !== null || !status.configured} checked={status.enabled} onChange={(value) => void toggleCdn(field, value, label)} /></div>
                  <Typography.Text type="secondary" style={{ fontSize: 12 }}>{status.error ?? (status.configured ? `${hint}（${status.domain}${status.expectedAuthTtlSeconds ? `，控制台 TypeA 有效时长需为 ${status.expectedAuthTtlSeconds} 秒` : ""}）` : "未配置：请在服务器 .env 设置对应域名并重新部署后可开启")}</Typography.Text>
                </div>;
              })}
              <Typography.Paragraph type="secondary" style={{ marginBottom: 0, marginTop: 4 }}>上海自建线路的源站出口为 5 Mbps，多人观看请开启直播 CDN。修改会记入操作日志。</Typography.Paragraph>
            </Space> : <Spin />}
          </Card>
        </Col>
      </Row>
    </>}

    <Card title="操作日志" extra={<Space>
      <Select allowClear placeholder="按动作筛选" style={{ minWidth: 140 }} value={action} onChange={(value) => { setAction(value); setPage(1); }}
        options={(logs?.actions ?? []).map((row) => ({ value: row.action, label: `${actionText[row.action] ?? row.action}（${row.count}）` }))} />
      <Button icon={<ReloadOutlined />} loading={loading} onClick={() => void refresh()}>刷新</Button>
    </Space>} styles={{ body: { padding: 0 } }}>
      <Table<AuditRow> rowKey="id" dataSource={logs?.items ?? []} loading={loading && !logs} pagination={{ current: page, pageSize: 5, total: logs?.total ?? 0, showSizeChanger: false, onChange: setPage, showTotal: (total) => `共 ${total} 条` }} scroll={{ x: 750 }}
        columns={[
          { title: "时间", width: 170, render: (_, row) => new Date(row.createdAt).toLocaleString("zh-CN") },
          { title: "动作", width: 110, render: (_, row) => <Tag color={row.action.includes("FAILED") ? "red" : row.action.startsWith("PUBLISH") ? "green" : "blue"}>{actionText[row.action] ?? row.action}</Tag> },
          { title: "操作者", dataIndex: "actorName", width: 110 },
          { title: "详情", dataIndex: "detail", ellipsis: true },
          { title: "IP", dataIndex: "ip", width: 130, render: (ip: string | null) => ip ? <Typography.Text copyable style={{ fontSize: 12 }}>{ip}</Typography.Text> : "—" }
        ]} />
    </Card>
  </Space>;
}
