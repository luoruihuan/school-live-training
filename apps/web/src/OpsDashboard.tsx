import { useCallback, useEffect, useState } from "react";
import { Alert, Button, Card, Col, Progress, Row, Select, Space, Spin, Statistic, Table, Tag, Typography } from "antd";
import { ReloadOutlined } from "@ant-design/icons";
import { api } from "./api";

type AlertItem = { key: string; level: "ok" | "warn" | "danger"; title: string; message: string };
type Overview = {
  server: { diskPercent: number | null; diskFreeGb: number | null; recordingTotalMb: number; recordingCount: number; liveSecondsTotal: number };
  streams: { streamName: string; clients: number; kbps: number }[];
  viewers: number;
  services: { name: string; ok: boolean }[];
  users: { total: number; todayLogins: number; activeSessions: number };
  alerts: AlertItem[];
};
type AuditRow = { id: string; actorName: string; action: string; detail: string; ip: string | null; createdAt: string };
type LogsPage = { items: AuditRow[]; total: number; page: number; pageSize: number; actions: { action: string; count: number }[] };

const actionText: Record<string, string> = {
  LOGIN: "登录成功", LOGIN_FAILED: "登录失败", LOGOUT: "退出登录", PASSWORD_CHANGED: "修改密码", PASSWORD_RESET: "重置密码",
  USER_CREATED: "创建账号", USER_DISABLED: "停用账号", USER_ENABLED: "启用账号", POINTS_ADJUST: "积分调整",
  PUBLISH_START: "开始直播", PUBLISH_STOP: "结束直播", RECORDING_SAVED: "回放入库", REPLAY_PLAYED: "观看回放", ORDER_COMPLETED: "订单完成"
};

const alertStyle = { ok: { type: "success" as const, color: "green" }, warn: { type: "warning" as const, color: "orange" }, danger: { type: "error" as const, color: "red" } };

export function OpsDashboard() {
  const [overview, setOverview] = useState<Overview>();
  const [logs, setLogs] = useState<LogsPage>();
  const [action, setAction] = useState<string | undefined>();
  const [page, setPage] = useState(1);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    setLoading(true); setError("");
    try {
      const [data, logPage] = await Promise.all([
        api<Overview>("/ops/overview"),
        api<LogsPage>(`/ops/audit-logs?page=${page}${action ? `&action=${action}` : ""}`)
      ]);
      setOverview(data); setLogs(logPage);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "读取失败");
    } finally { setLoading(false); }
  }, [page, action]);

  useEffect(() => { void refresh(); }, [refresh]);

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
        <Col xs={12} md={6}><Card><Statistic title="当前观看人数" value={overview.viewers} suffix="路" /></Card></Col>
        <Col xs={12} md={6}><Card><Statistic title="今日登录" value={overview.users.todayLogins} suffix={`/ 在线 ${overview.users.activeSessions}`} /></Card></Col>
        <Col xs={12} md={6}><Card><Statistic title="回放存储" value={(overview.server.recordingTotalMb / 1024).toFixed(1)} suffix={`GB / ${overview.server.recordingCount} 条`} /></Card></Col>
        <Col xs={12} md={6}><Card><Statistic title="累计直播时长" value={(overview.server.liveSecondsTotal / 3600).toFixed(1)} suffix="小时" /></Card></Col>
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
              {overview.streams.length ? overview.streams.map((stream) => `${stream.streamName.slice(-6)}（${stream.clients} 路 · ${stream.kbps} kbps）`).join("；") : "当前没有正在进行的直播"}
            </Typography.Paragraph>
          </Card>
        </Col>
      </Row>
    </>}

    <Card title="操作日志" extra={<Space>
      <Select allowClear placeholder="按动作筛选" style={{ minWidth: 140 }} value={action} onChange={(value) => { setAction(value); setPage(1); }}
        options={(logs?.actions ?? []).map((row) => ({ value: row.action, label: `${actionText[row.action] ?? row.action}（${row.count}）` }))} />
      <Button icon={<ReloadOutlined />} loading={loading} onClick={() => void refresh()}>刷新</Button>
    </Space>} styles={{ body: { padding: 0 } }}>
      <Table<AuditRow> rowKey="id" dataSource={logs?.items ?? []} loading={loading && !logs} pagination={{ current: page, pageSize: 20, total: logs?.total ?? 0, showSizeChanger: false, onChange: setPage, showTotal: (total) => `共 ${total} 条` }} scroll={{ x: 750 }}
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
