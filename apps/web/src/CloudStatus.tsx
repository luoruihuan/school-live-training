import { useEffect, useState } from "react";
import { Alert, Button, Card, Descriptions, Space, Steps, Table, Tag, Typography } from "antd";
import { api } from "./api";

type Status = { secureCookie: boolean; retentionDays: number; settings: { name: string; label: string; configured: boolean }[] };
export function CloudStatus() {
  const [status, setStatus] = useState<Status>();
  const [error, setError] = useState("");
  const [revision, setRevision] = useState(0);
  useEffect(() => { api<Status>("/admin/cloud-status").then((s) => { setStatus(s); setError(""); }).catch((e: unknown) => setError(e instanceof Error ? e.message : "检查失败")); }, [revision]);
  return <Space orientation="vertical" className="full-width" size="large">
    <Alert showIcon type="info" title="基础链路：OBS 开播 → 学生观看 → 自动录制 → 查看回放" description="这里只检查服务端配置是否填写；实际能否推流、录制和播放，仍需完成一次真实课程验证。" />
    {error && <Alert type="error" title={error} />}
    <Card title="直播与回放必要配置" extra={<Button onClick={() => setRevision((n) => n + 1)}>重新检查</Button>} loading={!status && !error}>
      {status && <><Descriptions className="spaced" items={[{ key: "cookie", label: "HTTPS Cookie", children: status.secureCookie ? "已启用" : "未启用（仅限本地）" }, { key: "days", label: "回放保留", children: `${status.retentionDays} 天` }]} /><Table size="small" rowKey="name" pagination={false} scroll={{ x: 500 }} dataSource={status.settings} columns={[{ title: "用途", dataIndex: "label" }, { title: "服务端配置", dataIndex: "name", render: (v: string) => <Typography.Text code>{v}</Typography.Text> }, { title: "状态", dataIndex: "configured", render: (v: boolean) => <Tag color={v ? "green" : "orange"}>{v ? "已填写 · 待实测" : "待配置"}</Tag> }]} /></>}
    </Card>
    <Card title="开通后验证"><Steps orientation="vertical" current={-1} items={[{ title: "直播", content: "配置推流和播放域名、鉴权及 HTTPS；教师用 OBS 开播，学生端确认能观看。" }, { title: "回放", content: "配置 CSS 的 MP4 录制到 COS，并将回调指向 /api/webhooks/css；停播后确认回放出现且能播放。" }]} /></Card>
    <Alert type="warning" showIcon title="腾讯云控制台还需完成录制配置" description="COS 权限、录制模板、回调绑定及存储生命周期由管理员在腾讯云配置；本页面不会自动开通，也不展示或保存密钥原文。" />
  </Space>;
}
