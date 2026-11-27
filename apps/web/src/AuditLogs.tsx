import { useCallback, useEffect, useState } from "react";
import { Alert, Button, Card, Select, Table, Tag, Typography } from "antd";
import { ReloadOutlined } from "@ant-design/icons";
import { api } from "./api";

type AuditRow = { id: string; actorName: string; action: string; detail: string; ip: string | null; createdAt: string };
type LogsPage = { items: AuditRow[]; total: number; page: number; pageSize: number; actions: { action: string; count: number }[] };

const actionText: Record<string, string> = {
  LOGIN: "登录成功", LOGIN_FAILED: "登录失败", LOGOUT: "退出登录", PASSWORD_CHANGED: "修改密码", PASSWORD_RESET: "重置密码",
  USER_CREATED: "创建账号", USER_DISABLED: "停用账号", USER_ENABLED: "启用账号", POINTS_ADJUST: "积分调整",
  PUBLISH_START: "开始直播", PUBLISH_STOP: "结束直播", RECORDING_SAVED: "回放入库", REPLAY_PLAYED: "观看回放",
  PRODUCT_ADDED: "添加商品", PRODUCT_REMOVED: "移除商品", CDN_SWITCH: "CDN 切换", LIVE_PROVIDER_SWITCH: "直播线路切换",
  ORDER_COMPLETED: "订单完成", ALERT_TEST: "测试告警"
};

const actionColor = (action: string) => action.includes("FAILED") ? "red" : action.startsWith("PUBLISH") ? "green" : ["CDN_SWITCH", "LIVE_PROVIDER_SWITCH", "ALERT_TEST"].includes(action) ? "purple" : "blue";

export function AuditLogs() {
  const [logs, setLogs] = useState<LogsPage>();
  const [action, setAction] = useState<string | undefined>();
  const [page, setPage] = useState(1);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    setLoading(true); setError("");
    try { setLogs(await api<LogsPage>(`/ops/audit-logs?page=${page}&pageSize=20${action ? `&action=${action}` : ""}`)); }
    catch (reason) { setError(reason instanceof Error ? reason.message : "读取失败"); }
    finally { setLoading(false); }
  }, [page, action]);

  useEffect(() => { void refresh(); }, [refresh]);

  return <>
    <div className="ops-toolbar">
      <Select allowClear aria-label="按动作筛选" placeholder="按动作筛选" style={{ minWidth: 220 }} value={action} loading={loading && !logs}
        onChange={(value) => { setAction(value); setPage(1); }}
        options={(logs?.actions ?? []).map((row) => ({ value: row.action, label: `${actionText[row.action] ?? row.action}（${row.count}）` }))} />
      <Button icon={<ReloadOutlined />} loading={loading} onClick={() => void refresh()}>刷新</Button>
    </div>
    {error && <Alert type="error" showIcon title={error} action={<Button size="small" onClick={() => void refresh()}>重试</Button>} className="spaced" />}
    <Card styles={{ body: { padding: 0 } }}>
      <Table<AuditRow> rowKey="id" dataSource={logs?.items ?? []} loading={loading} scroll={{ x: 750 }}
        pagination={{ current: page, pageSize: 20, total: logs?.total ?? 0, showSizeChanger: false, onChange: setPage, showTotal: (total) => `共 ${total} 条` }}
        columns={[
          { title: "时间", width: 180, render: (_, row) => new Date(row.createdAt).toLocaleString("zh-CN") },
          { title: "动作", width: 120, render: (_, row) => <Tag color={actionColor(row.action)}>{actionText[row.action] ?? row.action}</Tag> },
          { title: "操作者", dataIndex: "actorName", width: 120 },
          { title: "详情", dataIndex: "detail", ellipsis: true },
          { title: "IP", dataIndex: "ip", width: 140, render: (ip: string | null) => ip ? <Typography.Text copyable style={{ fontSize: 12 }}>{ip}</Typography.Text> : "—" }
        ]} />
    </Card>
  </>;
}
