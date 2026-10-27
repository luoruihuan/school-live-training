import { useEffect, useState } from "react";
import { Alert, App, Button, Card, Form, Input, InputNumber, Modal, Popconfirm, Select, Space, Table, Tag, Typography } from "antd";
import { EditOutlined, LinkOutlined, PlusOutlined, VideoCameraOutlined } from "@ant-design/icons";
import { api, pointText, patch, post, type Product, type Room, type Store } from "./api";
import { EntityEditor, type EditorKind } from "./EntityEditor";
import type { Platform } from "./usePlatform";
import { NoData, ProductImage, RoomStatus } from "./ui";
import { Player } from "./Player";
import { Replay } from "./Replay";
import { Chat } from "./Chat";

export type ManageTab = "rooms" | "stores" | "products" | "coupons";
export function Management({ tab, data, onNavigate }: { tab: ManageTab; data: Platform; onNavigate: (tab: ManageTab) => void }) {
  const [editor, setEditor] = useState<{ kind: EditorKind; entity?: Store | Room | Product; roomId?: string }>();
  const [binding, setBinding] = useState<Room>();
  const [publish, setPublish] = useState<{ title: string; url: string; expiresAt: string }>();
  const [setupRoomId, setSetupRoomId] = useState<string>();
  const [preview, setPreview] = useState<{ room: Room; mode: "live" | "replay" | "mock" }>();
  const [search, setSearch] = useState("");
  const kind = { rooms: "room", stores: "store", products: "product", coupons: "coupon" }[tab] as EditorKind;
  const label = { rooms: "直播间", stores: "店铺", products: "商品", coupons: "优惠券" }[tab];
  return <>
    <div className="admin-toolbar"><Input.Search aria-label={`搜索${label}`} placeholder={`搜索${label}名称`} value={search} onChange={(e) => setSearch(e.target.value)} allowClear /><Button type="primary" icon={<PlusOutlined />} onClick={() => setEditor({ kind })} disabled={kind !== "store" && !data.stores.length}>新建{label}</Button></div>
    {!data.stores.length && tab !== "stores" && <Alert type="info" title="先创建店铺，才能添加直播间、商品和优惠券。" action={<Button size="small" onClick={() => onNavigate("stores")}>去创建店铺</Button>} className="spaced" showIcon />}
    <Card styles={{ body: { padding: 0 } }}>
      {tab === "stores" && <Table<Store> rowKey="id" dataSource={data.stores.filter((s) => s.name.includes(search))} pagination={{ pageSize: 10 }} scroll={{ x: 600 }} columns={[
        { title: "店铺", dataIndex: "name", render: (name: string) => <strong>{name}</strong> }, { title: "店铺简介", dataIndex: "description", ellipsis: true, render: (v: string) => v || "—" },
        { title: "直播间", render: (_, s) => data.rooms.filter((r) => r.storeId === s.id).length }, { title: "商品", render: (_, s) => data.products.filter((p) => p.storeId === s.id).length },
        { title: "操作", render: (_, s) => <Button type="link" icon={<EditOutlined />} onClick={() => setEditor({ kind: "store", entity: s })}>编辑</Button> }
      ]} />}
      {tab === "rooms" && <Table<Room> rowKey="id" dataSource={data.rooms.filter((r) => r.title.includes(search))} pagination={{ pageSize: 10 }} scroll={{ x: 850 }} columns={[
        { title: "课堂名称", dataIndex: "title", render: (v: string) => <strong>{v}</strong> }, { title: "所属店铺", render: (_, r) => r.store.name },
        { title: "状态", render: (_, r) => <RoomStatus status={r.status} /> }, { title: "操作", render: (_, r) => <Space wrap size={0}>
          <Button type="link" onClick={() => setSetupRoomId(r.id)}>配置本场</Button><Button type="link" onClick={() => setPreview({ room: r, mode: "live" })}>查看课堂</Button>
        </Space> }
      ]} />}
      {tab === "products" && <Table<Product> rowKey="id" dataSource={data.products.filter((p) => p.name.includes(search))} pagination={{ pageSize: 10 }} scroll={{ x: 750 }} columns={[
        { title: "商品", render: (_, p) => <div className="table-product"><ProductImage product={p} /><div><strong>{p.name}</strong><p className="muted small">{data.stores.find((s) => s.id === p.storeId)?.name}</p></div></div> },
        { title: "兑换积分", render: (_, p) => pointText(p.pointsPrice) }, { title: "自提点", dataIndex: "pickupPoint" }, { title: "状态", render: (_, p) => <Tag color={p.isActive ? "green" : "default"}>{p.isActive ? "已上架" : "已下架"}</Tag> },
        { title: "操作", render: (_, p) => <Space><Button type="link" onClick={() => setEditor({ kind: "product", entity: p })}>编辑</Button><Popconfirm title={`确认${p.isActive ? "下架" : "上架"}该商品？`} onConfirm={() => data.run(() => patch(`/products/${p.id}`, { isActive: !p.isActive }), "商品状态已更新")}><Button type="link" danger={p.isActive} disabled={data.busy}>{p.isActive ? "下架" : "上架"}</Button></Popconfirm></Space> }
      ]} />}
      {tab === "coupons" && <Table rowKey="id" dataSource={data.coupons.filter((c) => c.name.includes(search))} pagination={{ pageSize: 10 }} scroll={{ x: 600 }} columns={[
        { title: "优惠券", dataIndex: "name" }, { title: "适用直播间", render: (_, c) => `${c.store.name} / ${c.room.title}` }, { title: "抵扣积分", render: (_, c) => pointText(c.pointsDiscount) }, { title: "到期时间", render: (_, c) => new Date(c.expiresAt).toLocaleString("zh-CN") },
        { title: "操作", render: (_, c) => <Popconfirm title="停用后，已领取但未使用的券也将无法抵扣。确认停用？" onConfirm={() => void data.run(() => patch(`/coupons/${c.id}/expire`, {}), "优惠券已停用")}><Button type="link" danger disabled={data.busy}>停用</Button></Popconfirm> }
      ]} />}
    </Card>
    {tab === "coupons" && <p className="muted small">显示有效期内的优惠券；每人每券限领一次，兑换时抵扣适用商品的积分。</p>}
    {editor && <EntityEditor {...editor} data={data} close={() => setEditor(undefined)} />}
    {binding && <RoomProducts room={binding} data={data} close={() => setBinding(undefined)} />}
    {setupRoomId && data.rooms.find((room) => room.id === setupRoomId) && <RoomSetup room={data.rooms.find((room) => room.id === setupRoomId)!} close={() => setSetupRoomId(undefined)} edit={() => { const room = data.rooms.find((item) => item.id === setupRoomId)!; setSetupRoomId(undefined); setEditor({ kind: "room", entity: room }); }} bind={() => { const room = data.rooms.find((item) => item.id === setupRoomId)!; setSetupRoomId(undefined); setBinding(room); }} coupon={() => { setEditor({ kind: "coupon", roomId: setupRoomId }); setSetupRoomId(undefined); }} publish={() => { const room = data.rooms.find((item) => item.id === setupRoomId)!; void data.run(async () => { const result = await api<{ url: string; expiresAt: string }>(`/rooms/${room.id}/publish`); setPublish({ title: room.title, ...result }); setSetupRoomId(undefined); }, "推流信息已获取"); }} preview={(mode) => { const room = data.rooms.find((item) => item.id === setupRoomId)!; setSetupRoomId(undefined); setPreview({ room, mode }); }} />}
    <Modal title={preview && `${preview.room.title} · ${preview.mode === "replay" ? "课程回放" : "课堂预览"}`} open={!!preview} onCancel={() => setPreview(undefined)} footer={<Button onClick={() => setPreview(undefined)}>关闭</Button>} width={760} destroyOnHidden>
      {preview?.mode === "replay" ? <Replay roomId={preview.room.id} /> : preview && <><Player roomId={preview.room.id} previewMock={preview.mode === "mock"} /><Chat roomId={preview.room.id} canModerate /></>}
    </Modal>
    <Modal title={publish?.title ? `${publish.title} · 推流设置` : "推流设置"} open={!!publish} onCancel={() => setPublish(undefined)} footer={<Button onClick={() => setPublish(undefined)}>关闭</Button>}>
      {publish && <Space orientation="vertical" size="middle" className="full-width"><Alert type="info" showIcon title="请在 OBS 中选择自定义服务，填入以下信息" description="推流信息仅交给授课教师；实际结束直播请停止 OBS 推流。" />
        <div><b>OBS 服务器</b><Typography.Paragraph copyable className="address-text">{publish.url.slice(0, publish.url.lastIndexOf("/"))}</Typography.Paragraph></div><div><b>OBS 串流密钥</b><Typography.Paragraph copyable className="address-text">{publish.url.slice(publish.url.lastIndexOf("/") + 1)}</Typography.Paragraph></div>
        <p className="muted">地址有效至 {new Date(publish.expiresAt).toLocaleString("zh-CN")}。过期后重新获取。</p>
      </Space>}
    </Modal>
  </>;
}

function RoomSetup({ room, close, edit, bind, coupon, publish, preview }: { room: Room; close: () => void; edit: () => void; bind: () => void; coupon: () => void; publish: () => void; preview: (mode: "live" | "replay" | "mock") => void }) {
  const { message } = App.useApp();
  return <Modal open title={`${room.title} · 本场配置`} onCancel={close} footer={<Button onClick={close}>完成</Button>}>
    <Space orientation="vertical" className="full-width" size="middle">
      <Alert showIcon type={room.status === "LIVE" ? "success" : "info"} title={room.status === "LIVE" ? "已收到直播推流" : "开播以 OBS 实际推流为准"} description="修改课堂显示状态不会启动或停止直播。结束时请停止 OBS 推流。" />
      <div className="room-setup-row"><span>课堂信息</span><RoomStatus status={room.status} /><Button onClick={edit}>编辑课堂</Button></div>
      <div className="room-setup-row"><span>本场商品</span><Tag color={room.productCount ? "green" : "orange"}>{room.productCount ? `${room.productCount} 件已绑定` : "待配置"}</Tag><Button onClick={bind}>配置商品</Button></div>
      <div className="room-setup-row"><span>优惠券（可选）</span><Tag>{room.couponCount} 张</Tag><Button onClick={coupon}>设置优惠券</Button></div>
      <div className="room-setup-row"><span>教师推流</span><Button icon={<VideoCameraOutlined />} onClick={publish}>获取 OBS 设置</Button></div>
      <div className="room-setup-row"><span>学生入口</span><Button icon={<LinkOutlined />} onClick={() => void navigator.clipboard.writeText(`${location.origin}/?room=${room.id}`).then(() => message.success("课堂链接已复制")).catch(() => message.error("复制失败，请复制浏览器地址"))}>复制观看链接</Button></div>
      {import.meta.env.DEV && <div className="room-setup-row"><span>本地视频演示</span><Button onClick={() => preview("mock")}>用桌面 MP4 预览</Button></div>}
      <div className="room-setup-row"><span>课程回放</span><Tag>{room.recordingCount} 条可看</Tag><Button onClick={() => preview("replay")}>查看回放</Button></div>
    </Space>
  </Modal>;
}

function RoomProducts({ room, data, close }: { room: Room; data: Platform; close: () => void }) {
  const [items, setItems] = useState<Product[]>([]);
  const [error, setError] = useState("");
  const { message } = App.useApp();
  const [form] = Form.useForm<{ productId: string; position: number }>();
  async function load() { setItems(await api<Product[]>(`/rooms/${room.id}/products`)); setError(""); }
  useEffect(() => { void load().catch((e: unknown) => setError(e instanceof Error ? e.message : "读取失败")); }, [room.id]);
  async function change(action: () => Promise<unknown>) { if (await data.run(action, "本场商品已更新")) await load().catch(() => message.error("列表刷新失败，请重新打开")); }
  return <Modal open title={`${room.title} · 本场商品`} onCancel={close} footer={<Button onClick={close}>完成</Button>}>
    {error && <Alert type="error" title={error} />}
    <Form form={form} layout="vertical" initialValues={{ position: 0 }} onFinish={(v) => void change(() => post(`/rooms/${room.id}/products`, v))}>
      <Form.Item name="productId" label="同店铺商品" rules={[{ required: true, message: "请选择商品" }]}><Select placeholder="选择要绑定或调整顺序的商品" options={data.products.filter((p) => p.storeId === room.storeId).map((p) => ({ value: p.id, label: `${p.name}${p.isActive ? "" : "（已下架）"}` }))} /></Form.Item><Form.Item name="position" label="展示顺序（越小越靠前）" rules={[{ required: true }]}><InputNumber min={0} max={9999} precision={0} /></Form.Item><Button htmlType="submit" type="primary" loading={data.busy}>绑定 / 更新顺序</Button>
    </Form><div className="spaced-top">{items.map((p) => <div className="binding-row" key={p.id}><span><Tag>{p.position ?? 0}</Tag>{p.name}{!p.isActive && <Tag>已下架</Tag>}</span><Popconfirm title="从本场移除此商品？" onConfirm={() => change(() => api(`/rooms/${room.id}/products/${p.id}`, { method: "DELETE" }))}><Button type="text" danger disabled={data.busy}>解绑</Button></Popconfirm></div>)}{!items.length && <NoData text="本场暂未绑定商品" />}</div>
  </Modal>;
}
