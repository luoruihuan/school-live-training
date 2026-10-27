import { useEffect, useState } from "react";
import { Alert, Button, Card, Input, Popconfirm, Space, Table, Tag, Typography } from "antd";
import { PlusOutlined, ReloadOutlined } from "@ant-design/icons";
import { api, pointText, patch, type ManagedUser, type Order } from "./api";
import { EntityEditor } from "./EntityEditor";
import type { Platform } from "./usePlatform";

export function Accounts({ data }: { data: Platform }) {
  const [users, setUsers] = useState<ManagedUser[]>([]);
  const [search, setSearch] = useState("");
  const [error, setError] = useState("");
  const [editor, setEditor] = useState<"create" | ManagedUser>();
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    let active = true;
    api<ManagedUser[]>("/users").then((items) => { if (active) { setUsers(items); setError(""); } }).catch((e: unknown) => { if (active) setError(e instanceof Error ? e.message : "读取账号失败"); });
    return () => { active = false; };
  }, [revision]);
  return <>
    {error && <Alert type="error" title={error} className="spaced" action={<Button size="small" onClick={() => setRevision((n) => n + 1)}>重试</Button>} />}
    <div className="admin-toolbar"><Input.Search aria-label="搜索账号" placeholder="搜索姓名或邮箱" allowClear onChange={(e) => setSearch(e.target.value)} /><Space><Button icon={<ReloadOutlined />} aria-label="刷新账号" onClick={() => setRevision((n) => n + 1)} /><Button type="primary" icon={<PlusOutlined />} onClick={() => setEditor("create")}>新建账号</Button></Space></div>
    <Card styles={{ body: { padding: 0 } }}><Table<ManagedUser> rowKey="id" scroll={{ x: 800 }} dataSource={users.filter((u) => `${u.displayName}${u.email}`.includes(search))} pagination={{ pageSize: 10 }} columns={[
      { title: "姓名", dataIndex: "displayName" }, { title: "账号邮箱", dataIndex: "email" }, { title: "角色", render: (_, u) => <Tag color={u.role === "ADMIN" ? "purple" : u.role === "TEACHER" ? "blue" : "default"}>{u.role === "ADMIN" ? "管理员" : u.role === "TEACHER" ? "教师" : "学生"}</Tag> },
      { title: "状态", render: (_, u) => <Tag color={u.isActive ? "green" : "red"}>{u.isActive ? "正常" : "已停用"}</Tag> },
      { title: "操作", render: (_, u) => u.role === "ADMIN" ? <Typography.Text type="secondary">管理员账号</Typography.Text> : <Space><Button type="link" onClick={() => setEditor(u)}>重置密码</Button><Popconfirm title={u.isActive ? "停用后此账号将立即无法使用，确认停用？" : "确认重新启用此账号？"} onConfirm={async () => { if (await data.run(() => patch(`/users/${u.id}`, { isActive: !u.isActive }), "账号状态已更新")) setRevision((n) => n + 1); }}><Button type="link" danger={u.isActive} disabled={data.busy}>{u.isActive ? "停用" : "启用"}</Button></Popconfirm></Space> }
    ]} /></Card>
    {editor && <EntityEditor kind={editor === "create" ? "user" : "password"} entity={editor === "create" ? undefined : editor} data={data} close={() => setEditor(undefined)} saved={() => setRevision((n) => n + 1)} />}
  </>;
}

export function StaffOrders() {
  const [result, setResult] = useState<{ items: Order[]; total: number }>({ items: [], total: 0 });
  const [q, setQ] = useState("");
  const [page, setPage] = useState(1);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    let active = true; setLoading(true);
    api<{ items: Order[]; total: number }>(`/staff/orders?page=${page}&q=${encodeURIComponent(q)}`).then((items) => { if (active) { setResult(items); setError(""); } }).catch((e: unknown) => { if (active) setError(e instanceof Error ? e.message : "读取订单失败"); }).finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [page, q, revision]);
  return <>
    <div className="admin-toolbar"><Input.Search aria-label="搜索订单" placeholder="搜索订单号、学生姓名、邮箱或商品" allowClear onSearch={(v) => { setQ(v); setPage(1); }} /><Button icon={<ReloadOutlined />} onClick={() => setRevision((n) => n + 1)}>刷新订单</Button></div>
    {error && <Alert type="error" title={error} showIcon className="spaced" />}
    <Card styles={{ body: { padding: 0 } }}><Table<Order> loading={loading} rowKey="id" dataSource={result.items} scroll={{ x: 850 }} pagination={{ current: page, pageSize: 20, total: result.total, showSizeChanger: false, onChange: setPage, showTotal: (total) => `共 ${total} 笔` }} expandable={{ expandedRowRender: (order) => <div><Typography.Paragraph copyable>订单号：{order.id}</Typography.Paragraph>{order.items.map((item) => <p key={item.id}>{item.name} × {item.quantity} · {pointText(item.pointsPrice * item.quantity)}{order.fulfillmentMethod === "PICKUP" && `；自提点：${item.pickupPoint}`}</p>)}<p>原价 {pointText(order.pointsSubtotal)}，优惠 {pointText(order.pointsDiscount)}</p>{order.fulfillmentMethod === "DELIVERY" && <p>送货地点：{order.deliveryAddress}</p>}</div> }} columns={[
      { title: "订单", render: (_, o) => <strong>{o.id.slice(-8).toUpperCase()}</strong> }, { title: "学生", render: (_, o) => <><span>{o.user?.displayName}</span><p className="small muted">{o.user?.email}</p></> },
      { title: "扣除积分", render: (_, o) => pointText(o.pointsTotal) }, { title: "交付", render: (_, o) => o.fulfillmentMethod === "PICKUP" ? "自提" : "送货" }, { title: "状态", render: (_, o) => <Tag color={o.status === "COMPLETED" ? "green" : "blue"}>{o.status === "COMPLETED" ? "已完成" : "待交付"}</Tag> }, { title: "下单时间", render: (_, o) => new Date(o.createdAt).toLocaleString("zh-CN") }, { title: "操作", render: (_, o) => o.status === "COMPLETED" ? "—" : <Popconfirm title="确认商品已交付？" onConfirm={async () => { try { await patch(`/staff/orders/${o.id}/complete`, {}); setRevision((n) => n + 1); } catch (e) { setError(e instanceof Error ? e.message : "更新订单失败"); } }}><Button type="link">标记完成</Button></Popconfirm> }
    ]} /></Card><p className="muted small">积分由管理员发放；完成交付后在此标记。平台不接在线支付或物流系统。</p>
  </>;
}
