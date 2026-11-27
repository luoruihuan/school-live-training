import { useCallback, useEffect, useState } from "react";
import { Alert, App, Button, Card, Progress, Space, Statistic, Table, Tag, Typography } from "antd";
import { ReloadOutlined, SendOutlined } from "@ant-design/icons";
import { api, post } from "./api";

type Provider = "SRS" | "CSS";
type ServiceStatus = "ok" | "down" | "unconfigured" | "unknown";
type Service = { key: string; name: string; detail: string; status: ServiceStatus };
type LiveSession = { title: string; startedAt: string; endedAt: string | null; seconds: number; reconnects: number; recordings: number; recordingDelaySeconds: number | null; recordingMissing: boolean };
type AlertItem = { key: string; level: "warn" | "danger"; title: string; message: string };
type Overview = {
  live: { provider: Provider; active: boolean; title: string | null; startedAt: string | null };
  metrics: { online: number; todayLogins: number; todayLoginFailures: number; replayViewsToday: number; sessionCount: number; liveSeconds: number; todayRecordings: number; recordingsMissing: number; recordingsTotalMb: number; recordingsCount: number; growth30dMb: number };
  services: Service[];
  resources: {
    recordings: { store: "COS" | "MinIO"; target: string; totalMb: number; count: number; growth30dMb: number; retentionDays: number; consoleUrl: string | null };
    server: { diskPercent: number | null; diskFreeGb: number | null; egressMbps: number };
  };
  sessions: LiveSession[];
  alerts: AlertItem[];
};

const gb = (mb: number) => `${(mb / 1024).toFixed(1)} GB`;
const clock = (iso: string) => new Date(iso).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit", hour12: false });
const danger = "#cf1322";
const warning = "#faad14";

export function formatDuration(seconds: number): string {
  const total = Math.max(0, Math.round(seconds));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  return hours ? `${hours} 小时 ${minutes} 分` : minutes ? `${minutes} 分 ${total % 60} 秒` : `${total} 秒`;
}

function ServiceTag({ status }: { status: ServiceStatus }) {
  if (status === "ok") return <Tag color="green">正常</Tag>;
  if (status === "down") return <Tag color="red">异常</Tag>;
  if (status === "unconfigured") return <Tag>未配置</Tag>;
  return <Tag color="default">未验证</Tag>;
}

export function OpsMonitor() {
  const { message } = App.useApp();
  const [data, setData] = useState<Overview>();
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [testing, setTesting] = useState(false);

  const refresh = useCallback(async () => {
    setLoading(true); setError("");
    try { setData(await api<Overview>("/ops/overview")); }
    catch (reason) { setError(reason instanceof Error ? reason.message : "读取失败"); }
    finally { setLoading(false); }
  }, []);

  useEffect(() => { void refresh(); }, [refresh]);

  async function testAlert() {
    setTesting(true);
    try {
      const status = await post<{ last: { ok: boolean } | null }>("/ops/alert-test", {});
      if (status.last?.ok) void message.success("测试告警已发送，请到飞书群里确认");
      else void message.error("测试告警没有发出去，请检查机器人配置");
      await refresh();
    } catch (reason) {
      void message.error(reason instanceof Error ? reason.message : "发送失败");
    } finally { setTesting(false); }
  }

  if (!data) return error
    ? <Alert type="error" showIcon title={error} action={<Button size="small" onClick={() => void refresh()}>重试</Button>} />
    : <Card loading />;

  const { live, metrics, services, resources, sessions, alerts } = data;
  const needsAction = alerts.some((item) => item.level === "danger");
  const liveMinutes = live.startedAt ? Math.max(0, Math.floor((Date.now() - new Date(live.startedAt).getTime()) / 60000)) : 0;
  const disk = resources.server.diskPercent;

  return <>
    <div className="ops-toolbar">
      <span className="ops-summary">
        {alerts.length ? <Tag color={needsAction ? "red" : "orange"}>{alerts.length} 项需注意</Tag> : <Tag color="green">全部正常</Tag>}
        <span className="muted">刚刚检查</span>
      </span>
      <Button icon={<ReloadOutlined />} loading={loading} onClick={() => void refresh()}>刷新</Button>
    </div>

    {alerts.length > 0 && <div className="ops-alerts">
      {alerts.map((item) => <Alert key={item.key} type={item.level === "danger" ? "error" : "warning"} showIcon title={item.title} description={item.message} />)}
    </div>}

    <div className="stat-grid ops-metrics">
      <Card>
        <Statistic title="直播状态" value={live.active ? "直播中" : "空闲"} valueStyle={live.active ? { color: danger } : undefined} />
        <p className="ops-metric__sub">{live.active ? `${live.title ?? ""}${liveMinutes ? ` · 已播 ${liveMinutes} 分钟` : ""}` : "当前没有正在进行的直播"}</p>
      </Card>
      <Card>
        <Statistic title="正在观看" value={metrics.online} suffix="人" />
        <p className="ops-metric__sub">今日登录 {metrics.todayLogins} 人{metrics.todayLoginFailures ? ` · 失败 ${metrics.todayLoginFailures} 次` : ""}</p>
      </Card>
      <Card>
        <Statistic title="今日开播" value={metrics.sessionCount} suffix="场" />
        <p className="ops-metric__sub">累计直播 {formatDuration(metrics.liveSeconds)} · 回放被看 {metrics.replayViewsToday} 次</p>
      </Card>
      <Card>
        <Statistic title="今日回放入库" value={metrics.todayRecordings} suffix="条" valueStyle={metrics.recordingsMissing ? { color: danger } : undefined} />
        <p className="ops-metric__sub">{metrics.recordingsMissing ? `${metrics.recordingsMissing} 场已关播但未入库` : sessions.length ? "今天的直播均已入库" : "今天没有直播"}</p>
      </Card>
    </div>

    <div className="ops-grid">
      <Card title="服务可达性" className="ops-grid__full">
        <div className="status-list">
          {services.map((service) => <div className="status-row" key={service.key}>
            <div>
              <div className="status-row__name">{service.name}</div>
              <div className="status-row__detail">{service.detail}</div>
            </div>
            <Space size={4}>
              {service.key === "alert" && service.status !== "unconfigured" && <Button type="link" size="small" icon={<SendOutlined />} loading={testing} onClick={() => void testAlert()}>发送测试</Button>}
              <ServiceTag status={service.status} />
            </Space>
          </div>)}
        </div>
      </Card>

      <Card title="回放存储" extra={<Tag>{resources.recordings.store}</Tag>}>
        <div className="fact-list">
          <div className="fact"><span className="fact__label">存储位置</span><span className="fact__value">{resources.recordings.target}</span></div>
          <div className="fact"><span className="fact__label">累计</span><span className="fact__value">{resources.recordings.count} 条 · {gb(resources.recordings.totalMb)}</span></div>
          <div className="fact"><span className="fact__label">近 30 天新增</span><span className="fact__value">{gb(resources.recordings.growth30dMb)}</span></div>
          <div className="fact"><span className="fact__label">保留期</span><span className="fact__value">{resources.recordings.retentionDays} 天</span></div>
        </div>
        {resources.recordings.consoleUrl && <Typography.Paragraph type="secondary" className="ops-note">回放、自适应码率转码与流量费用以 <a href={resources.recordings.consoleUrl} target="_blank" rel="noreferrer">腾讯云计费用量</a> 为准，统计有延迟。</Typography.Paragraph>}
      </Card>

      <Card title="服务器">
        <div className="fact-list">
          <div className="fact"><span className="fact__label">本地磁盘</span><span className="fact__value">{disk === null ? "读取失败" : `${disk}%`}</span></div>
          <Progress className="ops-progress" percent={disk ?? 0} showInfo={false} status={disk !== null && disk >= 85 ? "exception" : "normal"} strokeColor={disk !== null && disk >= 85 ? danger : disk !== null && disk >= 75 ? warning : undefined} />
          <div className="fact"><span className="fact__label">剩余空间</span><span className="fact__value">{resources.server.diskFreeGb !== null ? `${resources.server.diskFreeGb} GB` : "—"}</span></div>
          <div className="fact"><span className="fact__label">出口带宽</span><span className="fact__value">{resources.server.egressMbps} Mbps</span></div>
        </div>
        <Typography.Paragraph type="secondary" className="ops-note">{live.provider === "CSS" ? "直播视频不经过此服务器。本地磁盘存放数据库与系统文件，与回放存储无关。" : "源站出口上限 5 Mbps，多人观看请开启直播 CDN。本地磁盘存放数据库与系统文件。"}</Typography.Paragraph>
      </Card>

      <Card title="今日直播" className="ops-grid__full" styles={{ body: { padding: 0 } }}>
        <Table<LiveSession> rowKey={(row) => `${row.title}-${row.startedAt}`} dataSource={sessions} pagination={false} scroll={{ x: 560 }} locale={{ emptyText: "今天还没有开播" }}
          columns={[
            { title: "课堂", dataIndex: "title", width: 200 },
            { title: "开播", dataIndex: "startedAt", width: 90, render: (value: string) => clock(value) },
            { title: "结束", dataIndex: "endedAt", width: 90, render: (value: string | null) => value ? clock(value) : <span style={{ color: danger }}>直播中</span> },
            { title: "时长", dataIndex: "seconds", width: 130, render: (value: number) => formatDuration(value) },
            { title: "中断重连", dataIndex: "reconnects", width: 100, render: (value: number) => value ? <span style={{ color: warning }}>{value} 次</span> : <span className="muted">0 次</span> },
            { title: "回放", width: 180, render: (_, row) => row.recordingMissing ? <span style={{ color: danger }}>未入库</span> : row.endedAt ? <span>{row.recordings} 条{row.recordingDelaySeconds !== null ? ` · ${row.recordingDelaySeconds} 秒后入库` : ""}</span> : <span className="muted">关播后入库</span> }
          ]} />
      </Card>
    </div>
  </>;
}
