import { useEffect, useRef, useState } from "react";
import { Alert, Button, Card, Form, Input, InputNumber, Modal, Radio, Space, Table, Tag } from "antd";
import { ReloadOutlined } from "@ant-design/icons";
import { api, pointText, post, type ManagedUser } from "./api";

type PointMode = "ADD" | "DEDUCT" | "SET";
type PointEntry = { id: string; delta: number; balanceAfter: number; reason: string; createdAt: string; actor: { displayName: string } | null };
type PointEntryPage = { items: PointEntry[]; total: number; page: number; pageSize: number };

export function PointsManagement() {
  const [users, setUsers] = useState<ManagedUser[]>([]);
  const [search, setSearch] = useState("");
  const [selected, setSelected] = useState<ManagedUser>();
  const [historyUser, setHistoryUser] = useState<ManagedUser>();
  const [entries, setEntries] = useState<PointEntry[]>([]);
  const [entryPage, setEntryPage] = useState(1);
  const [entryTotal, setEntryTotal] = useState(0);
  const [mode, setMode] = useState<PointMode>("ADD");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [revision, setRevision] = useState(0);
  const requestKey = useRef(crypto.randomUUID());

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

  async function save(values: { points: number; reason: string; adminPassword: string }) {
    if (!selected || busy) return;
    setBusy(true); setError("");
    try {
      await post(`/users/${selected.id}/points`, { ...values, mode, requestKey: requestKey.current });
      setSelected(undefined);
      setRevision((value) => value + 1);
      if (historyUser?.id === selected.id) await openHistory(selected);
    } catch (reason) { setError(reason instanceof Error ? reason.message : "积分调整失败"); }
    finally { setBusy(false); }
  }

  return <>
    {error && <Alert type="error" title={error} showIcon className="spaced" />}
    <div className="admin-toolbar"><Input.Search aria-label="搜索积分账号" placeholder="搜索姓名或邮箱" allowClear onChange={(event) => setSearch(event.target.value)} /><Button icon={<ReloadOutlined />} onClick={() => setRevision((value) => value + 1)}>刷新</Button></div>
    <Card styles={{ body: { padding: 0 } }}><Table<ManagedUser> rowKey="id" dataSource={users.filter((user) => `${user.displayName}${user.email}`.includes(search))} pagination={{ pageSize: 10 }} scroll={{ x: 650 }} columns={[
      { title: "姓名", dataIndex: "displayName" }, { title: "账号邮箱", dataIndex: "email" },
      { title: "角色", render: (_, user) => user.role === "TEACHER" ? "教师" : "学生" },
      { title: "当前积分", render: (_, user) => <strong>{pointText(user.pointsBalance)}</strong> },
      { title: "操作", render: (_, user) => <Space><Button type="link" onClick={() => { requestKey.current = crypto.randomUUID(); setMode("ADD"); setSelected(user); }}>调整积分</Button><Button type="link" onClick={() => void openHistory(user)}>查看流水</Button></Space> }
    ]} /></Card>
    <p className="muted small">增加、扣减和设置余额均记录操作人、原因及调整后余额；流水按 20 笔一页分页查看。</p>
    <Modal title={`调整积分 · ${selected?.displayName ?? ""}`} open={!!selected} onCancel={() => setSelected(undefined)} footer={null} destroyOnHidden>
      <p>当前余额：{pointText(users.find((user) => user.id === selected?.id)?.pointsBalance ?? selected?.pointsBalance ?? 0)}</p>
      <Form layout="vertical" key={selected?.id} disabled={busy} onValuesChange={(changed) => { if (!("adminPassword" in changed)) requestKey.current = crypto.randomUUID(); }} onFinish={(values: { points: number; reason: string; adminPassword: string }) => void save(values)}>
        <Form.Item label="操作方式"><Radio.Group value={mode} onChange={(event) => { setMode(event.target.value as PointMode); requestKey.current = crypto.randomUUID(); }} options={[{ label: "增加", value: "ADD" }, { label: "扣减", value: "DEDUCT" }, { label: "设置余额", value: "SET" }]} /></Form.Item>
        <Form.Item name="points" label={mode === "SET" ? "调整后的余额" : "积分数量"} rules={[{ required: true, message: "请输入积分" }]}><InputNumber min={mode === "SET" ? 0 : 1} max={mode === "SET" ? 2_000_000_000 : 1_000_000} precision={0} className="full-width" /></Form.Item>
        <Form.Item name="reason" label="调整原因" rules={[{ required: true, whitespace: true, message: "请填写调整原因" }]}><Input maxLength={100} placeholder="例如：实训奖励、误发纠正" /></Form.Item>
        <Form.Item name="adminPassword" label="管理员登录密码" rules={[{ required: true, message: "请输入管理员密码" }]} extra="每次调整都需核验，防止他人仅凭未退出的后台会话批量发放积分。"><Input.Password autoComplete="current-password" /></Form.Item>
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
