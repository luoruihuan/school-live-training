import { useEffect, useRef, useState } from "react";
import { Alert, App, Button, Card, Form, Input, InputNumber, Modal, Radio, Space, Table, Tag } from "antd";
import { ReloadOutlined } from "@ant-design/icons";
import { api, pointText, post, type ManagedUser } from "./api";
import { TestTag } from "./ui";

type PointMode = "ADD" | "DEDUCT" | "SET";
type PointEntry = { id: string; delta: number; balanceAfter: number; reason: string; createdAt: string; actor: { displayName: string } | null };
type PointEntryPage = { items: PointEntry[]; total: number; page: number; pageSize: number };
type BatchResult = { userId: string; ok: boolean; balanceAfter?: number; error?: string };

export function PointsManagement() {
  const { modal, message } = App.useApp();
  const [users, setUsers] = useState<ManagedUser[]>([]);
  const [search, setSearch] = useState("");
  const [selected, setSelected] = useState<ManagedUser>();
  const [selectedIds, setSelectedIds] = useState<React.Key[]>([]);
  const [batchOpen, setBatchOpen] = useState(false);
  const [batchMode, setBatchMode] = useState<PointMode>("ADD");
  const [batchResult, setBatchResult] = useState<{ succeeded: number; failed: number; results: BatchResult[] }>();
  const [historyUser, setHistoryUser] = useState<ManagedUser>();
  const [entries, setEntries] = useState<PointEntry[]>([]);
  const [entryPage, setEntryPage] = useState(1);
  const [entryTotal, setEntryTotal] = useState(0);
  const [mode, setMode] = useState<PointMode>("ADD");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [revision, setRevision] = useState(0);
  const requestKey = useRef(crypto.randomUUID());
  const batchRequestKey = useRef(crypto.randomUUID());

  useEffect(() => {
    let active = true;
    api<ManagedUser[]>("/users").then((items) => { if (active) { setUsers(items.filter((item) => item.role !== "ADMIN")); setError(""); } })
      .catch((reason: unknown) => { if (active) setError(reason instanceof Error ? reason.message : "读取积分账号失败"); });
    return () => { active = false; };
  }, [revision]);

  async function openHistory(user: ManagedUser, page = 1) {
    setHistoryUser(user); setEntries([]); setError("");
    try {
      const result = await api<PointEntryPage>(`/users/${user.id}/points?page=${page}`);
      setEntries(result.items); setEntryPage(result.page); setEntryTotal(result.total);
    }
    catch (reason) { setError(reason instanceof Error ? reason.message : "读取积分流水失败"); }
  }

  async function turnHistoryPage(page: number) {
    if (!historyUser) return;
    setEntries([]);
    try {
      const result = await api<PointEntryPage>(`/users/${historyUser.id}/points?page=${page}`);
      setEntries(result.items); setEntryPage(result.page); setEntryTotal(result.total);
    }
    catch (reason) { setError(reason instanceof Error ? reason.message : "读取积分流水失败"); }
  }

  async function save(values: { points: number; reason: string }) {
    if (!selected || busy) return;
    const actionText = mode === "ADD" ? "增加" : mode === "DEDUCT" ? "扣减" : "设置余额为";
    const ok = await modal.confirm({
      title: `确认调整积分 · ${selected.displayName}`,
      content: `将${actionText} ${pointText(values.points)}（原因：${values.reason}），是否确认？`,
      okText: "确认调整", cancelText: "取消", okButtonProps: { danger: mode !== "ADD" }
    });
    if (!ok) return;
    setBusy(true); setError("");
    try {
      await post(`/users/${selected.id}/points`, { ...values, mode, requestKey: requestKey.current });
      setSelected(undefined);
      setRevision((value) => value + 1);
      if (historyUser?.id === selected.id) await openHistory(selected);
    } catch (reason) { setError(reason instanceof Error ? reason.message : "积分调整失败"); }
    finally { setBusy(false); }
  }

  async function saveBatch(values: { points: number; reason: string }) {
    if (busy || !selectedIds.length) return;
    const actionText = batchMode === "ADD" ? "增加" : batchMode === "DEDUCT" ? "扣减" : "设置余额为";
    const ok = await modal.confirm({
      title: `确认批量调整 · 已选 ${selectedIds.length} 个账号`,
      content: `将每个账号${actionText} ${pointText(values.points)}（原因：${values.reason}），是否确认？`,
      okText: "确认批量调整", cancelText: "取消", okButtonProps: { danger: batchMode !== "ADD" }
    });
    if (!ok) return;
    setBusy(true); setError("");
    try {
      const result = await post<{ results: BatchResult[]; succeeded: number; failed: number }>("/users/points-batch", {
        userIds: selectedIds, mode: batchMode, points: values.points, reason: values.reason, requestKey: batchRequestKey.current
      });
      setBatchResult(result);
      setBatchOpen(false);
      setSelectedIds([]);
      setRevision((value) => value + 1);
      void message.success(`批量调整完成：成功 ${result.succeeded} 人${result.failed ? `、失败 ${result.failed} 人` : ""}`);
    } catch (reason) { setError(reason instanceof Error ? reason.message : "批量调整失败"); }
    finally { setBusy(false); }
  }

  return <>
    {error && <Alert type="error" title={error} showIcon className="spaced" />}
    <div className="admin-toolbar"><Input.Search aria-label="搜索积分账号" placeholder="搜索姓名或邮箱" allowClear onChange={(event) => setSearch(event.target.value)} /><Space><Button icon={<ReloadOutlined />} onClick={() => setRevision((value) => value + 1)}>刷新</Button><Button disabled={!selectedIds.length || busy} onClick={() => { batchRequestKey.current = crypto.randomUUID(); setBatchMode("ADD"); setBatchResult(undefined); setBatchOpen(true); }}>批量赋分{selectedIds.length ? `（${selectedIds.length}）` : ""}</Button></Space></div>
    <Card styles={{ body: { padding: 0 } }}><Table<ManagedUser> rowKey="id" rowSelection={{ selectedRowKeys: selectedIds, onChange: setSelectedIds, getCheckboxProps: () => ({ disabled: false }) }} dataSource={users.filter((user) => `${user.displayName}${user.email}`.includes(search))} pagination={{ pageSize: 10 }} scroll={{ x: 650 }} columns={[
      { title: "姓名", render: (_, user) => <><TestTag show={user.isTest} />{user.displayName}</> }, { title: "账号邮箱", dataIndex: "email" },
      { title: "角色", render: (_, user) => user.role === "TEACHER" ? "教师" : "学生" },
      { title: "当前积分", render: (_, user) => <strong>{pointText(user.pointsBalance)}</strong> },
      { title: "操作", render: (_, user) => <Space><Button type="link" onClick={() => { requestKey.current = crypto.randomUUID(); setMode("ADD"); setSelected(user); }}>调整积分</Button><Button type="link" onClick={() => void openHistory(user)}>查看流水</Button></Space> }
    ]} /></Card>
    <p className="muted small">增加、扣减和设置余额均记录操作人、原因及调整后余额；流水按 20 笔一页分页查看。</p>
    <Modal title={`批量赋分 · 已选 ${selectedIds.length} 个账号`} open={batchOpen} onCancel={() => setBatchOpen(false)} footer={null} destroyOnHidden>
      <Form layout="vertical" disabled={busy} key={batchOpen ? "open" : "closed"} onValuesChange={() => { batchRequestKey.current = crypto.randomUUID(); }} onFinish={(values: { points: number; reason: string }) => void saveBatch(values)}>
        <Form.Item label="操作方式"><Radio.Group value={batchMode} onChange={(event) => { setBatchMode(event.target.value as PointMode); batchRequestKey.current = crypto.randomUUID(); }} options={[{ label: "增加", value: "ADD" }, { label: "扣减", value: "DEDUCT" }, { label: "设置余额", value: "SET" }]} /></Form.Item>
        <Form.Item name="points" label={batchMode === "SET" ? "调整后的余额（每人）" : "每人积分数量"} rules={[{ required: true, message: "请输入积分" }]}><InputNumber min={batchMode === "SET" ? 0 : 1} max={batchMode === "SET" ? 2_000_000_000 : 1_000_000} precision={0} className="full-width" /></Form.Item>
        <Form.Item name="reason" label="调整原因" rules={[{ required: true, whitespace: true, message: "请填写调整原因" }]}><Input maxLength={100} placeholder="例如：实训奖励、误发纠正" /></Form.Item>
        <Button type="primary" htmlType="submit" block loading={busy}>确认批量调整（{selectedIds.length} 人）</Button>
      </Form>
      <p className="muted small spaced-top">每人独立记一条积分流水；部分失败不影响其他人，可安全重试（已成功者不会重复调整）。</p>
    </Modal>
    {batchResult && <Modal title="批量赋分结果" open onCancel={() => setBatchResult(undefined)} footer={<Button type="primary" onClick={() => setBatchResult(undefined)}>知道了</Button>}>
      <Alert type={batchResult.failed ? "warning" : "success"} showIcon title={`成功 ${batchResult.succeeded} 人${batchResult.failed ? `，失败 ${batchResult.failed} 人` : ""}`} />
      {batchResult.failed > 0 && <Table className="spaced-top" rowKey="userId" size="small" pagination={false} dataSource={batchResult.results.filter((item) => !item.ok)} columns={[
        { title: "账号", render: (_, item) => users.find((user) => user.id === item.userId)?.displayName ?? item.userId.slice(-8) },
        { title: "失败原因", render: (_, item) => (item as { error?: string }).error ?? "未知原因" }
      ]} />}
    </Modal>}
    <Modal title={`调整积分 · ${selected?.displayName ?? ""}`} open={!!selected} onCancel={() => setSelected(undefined)} footer={null} destroyOnHidden>
      <p>当前余额：{pointText(users.find((user) => user.id === selected?.id)?.pointsBalance ?? selected?.pointsBalance ?? 0)}</p>
      <Form layout="vertical" key={selected?.id} disabled={busy} onValuesChange={() => { requestKey.current = crypto.randomUUID(); }} onFinish={(values: { points: number; reason: string }) => void save(values)}>
        <Form.Item label="操作方式"><Radio.Group value={mode} onChange={(event) => { setMode(event.target.value as PointMode); requestKey.current = crypto.randomUUID(); }} options={[{ label: "增加", value: "ADD" }, { label: "扣减", value: "DEDUCT" }, { label: "设置余额", value: "SET" }]} /></Form.Item>
        <Form.Item name="points" label={mode === "SET" ? "调整后的余额" : "积分数量"} rules={[{ required: true, message: "请输入积分" }]}><InputNumber min={mode === "SET" ? 0 : 1} max={mode === "SET" ? 2_000_000_000 : 1_000_000} precision={0} className="full-width" /></Form.Item>
        <Form.Item name="reason" label="调整原因" rules={[{ required: true, whitespace: true, message: "请填写调整原因" }]}><Input maxLength={100} placeholder="例如：实训奖励、误发纠正" /></Form.Item>
        <Button type="primary" htmlType="submit" block loading={busy}>确认调整</Button>
      </Form>
    </Modal>
    <Modal title={`积分流水 · ${historyUser?.displayName ?? ""}`} open={!!historyUser} onCancel={() => setHistoryUser(undefined)} footer={<Button onClick={() => setHistoryUser(undefined)}>关闭</Button>} width={760}>
      <Table<PointEntry> rowKey="id" dataSource={entries} pagination={{ current: entryPage, pageSize: 20, total: entryTotal, showSizeChanger: false, onChange: (page) => void turnHistoryPage(page), showTotal: (total) => `共 ${total} 笔` }} scroll={{ x: 600 }} columns={[
        { title: "时间", render: (_, entry) => new Date(entry.createdAt).toLocaleString("zh-CN") },
        { title: "变动", render: (_, entry) => <Tag color={entry.delta >= 0 ? "green" : "red"}>{entry.delta > 0 ? "+" : ""}{entry.delta}</Tag> },
        { title: "调整后", dataIndex: "balanceAfter" }, { title: "原因", dataIndex: "reason" },
        { title: "操作人", render: (_, entry) => entry.actor?.displayName ?? "系统" }
      ]} />
    </Modal>
  </>;
}
