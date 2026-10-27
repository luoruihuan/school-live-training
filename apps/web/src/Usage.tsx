import { useCallback, useEffect, useState } from "react";
import { Alert, App, Button, Card, DatePicker, Form, InputNumber, Progress, Space, Spin, Statistic, Table, Tag } from "antd";
import dayjs from "dayjs";
import { api, post } from "./api";

type UsageYear = {
  year: number;
  from: string;
  toExclusive: string;
  usedGb: number;
  quotaGb: number;
  remainingGb: number;
  percent: number;
  reachedThresholds: number[];
};

type UsageSummary = {
  configured: boolean;
  startDate?: string;
  years: UsageYear[];
  recentDays: { date: string; billedMb: number; source: string; updatedAt: string }[];
  unallocatedMb: number;
};

export function Usage({ isAdmin }: { isAdmin: boolean }) {
  const [summary, setSummary] = useState<UsageSummary | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const { modal } = App.useApp();
  const refresh = useCallback(async () => setSummary(await api<UsageSummary>("/usage/summary")), []);

  useEffect(() => { void refresh().catch((reason: unknown) => setError(reason instanceof Error ? reason.message : "无法读取流量台账")); }, [refresh]);

  async function submit(path: string, body: object, success: string): Promise<void> {
    if (busy) return;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await post(path, body);
      await refresh();
      setNotice(success);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "保存失败");
    } finally { setBusy(false); }
  }

  return <Space orientation="vertical" size="large" className="full-width">
    <Alert type="info" showIcon title="直播流量由管理员按腾讯云账单录入" description="所有直播间共享年度额度。本页只核对 CSS 直播观看流量，不自动读取账单或计算金额；回放播放、COS 存储及超额费用以腾讯云实际账单为准。额度耗尽后平台停止签发新地址，已有直播仍需到腾讯云停流。" />
    {error && <Alert type="error" title={error} action={<Button size="small" onClick={() => void refresh().catch(() => setError("刷新失败，请稍后重试"))}>重试</Button>} />}
    {notice && <Alert type="success" title={notice} closable />}
    {!summary && !error && <Spin />}
    {summary && !summary.configured && <Alert type="info" title="请先设置合同约定的服务起始日与年度额度。" />}
    {summary?.configured && <div className="usage-years">{summary.years.map((year) => <Card key={year.year} title={`第 ${year.year} 服务年度`} extra={<Tag color={year.percent >= 95 ? "red" : year.percent >= 80 ? "orange" : "green"}>{year.reachedThresholds.length ? `已达 ${year.reachedThresholds.at(-1)}% 提醒线` : "额度充足"}</Tag>}>
      <Statistic title={`${year.from} 至 ${year.toExclusive}（不含结束日）`} value={year.usedGb} precision={3} suffix="GB" />
      <Progress percent={Math.min(year.percent, 100)} status={year.percent >= 100 ? "exception" : "normal"} strokeColor={year.percent >= 95 ? "#cf443b" : year.percent >= 80 ? "#d99424" : "#3263dc"} />
      <div className="split muted small"><span>年度额度 {year.quotaGb.toLocaleString()} GB</span><span>剩余 {year.remainingGb.toLocaleString()} GB</span></div>
    </Card>)}</div>}
    {isAdmin && summary && <div className="usage-forms">
      {summary.recentDays.length === 0 && <Card title="服务周期与额度"><Form layout="vertical" key={summary.startDate ?? "new"} initialValues={{ startDate: summary.startDate ? dayjs(summary.startDate) : undefined, annualGb: summary.years[0]?.quotaGb ?? 10000 }} disabled={busy} onFinish={(v: { startDate: dayjs.Dayjs; annualGb: number }) => void submit("/usage/quota", { startDate: v.startDate.format("YYYY-MM-DD"), annualGb: v.annualGb }, "服务周期已保存")}>
        <Form.Item label="服务起始日" name="startDate" rules={[{ required: true, message: "请选择日期" }]}><DatePicker className="full-width" /></Form.Item><Form.Item label="每年额度（GB）" name="annualGb" rules={[{ required: true }]}><InputNumber className="full-width" min={1} max={1_000_000} precision={0} /></Form.Item><p className="muted small">按起始日计算两年，录入首条账单后将锁定周期和额度。</p><Button type="primary" htmlType="submit" loading={busy}>保存服务周期</Button>
      </Form></Card>}
      {summary.configured && <Card title="录入每日计费流量"><Form layout="vertical" disabled={busy} onFinish={(v: { date: dayjs.Dayjs; billedMb: number }) => { modal.confirm({ title: `保存 ${v.date.format("YYYY-MM-DD")} 的账单？`, content: `已计费流量 ${v.billedMb} MB。同一天已有记录会被本次值替换，请按腾讯云账单核实。`, onOk: () => submit("/usage/daily", { date: v.date.format("YYYY-MM-DD"), billedMb: v.billedMb }, "账单已保存") }); }}>
        <Form.Item label="账单日期" name="date" rules={[{ required: true, message: "请选择日期" }]}><DatePicker className="full-width" /></Form.Item><Form.Item label="CSS 已计费流量（MB）" name="billedMb" rules={[{ required: true }]}><InputNumber min={0} max={1_000_000_000} precision={3} className="full-width" /></Form.Item><p className="muted small">录入所有直播间当天合计，不填资源包余额。1 GB = 1,000 MB。</p><Button htmlType="submit" type="primary" loading={busy}>核对并保存</Button>
      </Form></Card>}
    </div>}
    {summary && <Card title="最近 30 条账单记录"><Table rowKey="date" dataSource={summary.recentDays} pagination={{ pageSize: 10 }} scroll={{ x: 550 }} columns={[{ title: "日期", dataIndex: "date" }, { title: "已计费流量（MB）", dataIndex: "billedMb", render: (v: number) => v.toLocaleString("zh-CN") }, { title: "来源", render: () => <Tag>人工核账</Tag> }, { title: "更新时间", dataIndex: "updatedAt", render: (v: string) => new Date(v).toLocaleString("zh-CN") }]} /></Card>}
  </Space>;
}
