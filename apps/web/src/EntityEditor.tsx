import { useState } from "react";
import { Button, DatePicker, Form, Input, InputNumber, Modal, Select, Upload } from "antd";
import { UploadOutlined } from "@ant-design/icons";
import type { Dayjs } from "dayjs";
import { patch, post, uploadImage, type ManagedUser, type Product, type Room, type Store } from "./api";
import type { Platform } from "./usePlatform";

export type EditorKind = "store" | "room" | "product" | "coupon" | "user" | "password";
type Values = { name?: string; description?: string; storeId?: string; roomId?: string; title?: string; status?: string; pointsPrice?: number; pickupPoint?: string; pointsDiscount?: number; expiresAt?: Dayjs; displayName?: string; email?: string; role?: string; password?: string };
export function EntityEditor({ kind, entity, roomId, data, close, saved }: {
  kind: EditorKind; entity?: Store | Room | Product | ManagedUser; roomId?: string; data: Platform; close: () => void; saved?: () => void;
}) {
  const [file, setFile] = useState<File>();
  const label = { store: "店铺", room: "直播间", product: "商品", coupon: "优惠券", user: "教学账号", password: "密码" }[kind];
  const initial = { role: "STUDENT", status: "DRAFT", ...entity, ...(roomId ? { roomId, storeId: data.rooms.find((room) => room.id === roomId)?.storeId } : {}) };
  async function submit(values: Values) {
    const ok = await data.run(async () => {
      let path = "";
      let body: object = values;
      switch (kind) {
        case "store": path = "/stores"; body = { name: values.name, description: values.description ?? "" }; break;
        case "room": path = "/rooms"; body = { title: values.title, ...(entity ? values.status === (entity as Room).status ? {} : { status: values.status } : { storeId: values.storeId }) }; break;
        case "product": path = "/products"; body = { storeId: values.storeId, name: values.name, description: values.description ?? "", pointsPrice: values.pointsPrice, pickupPoint: values.pickupPoint, ...(file ? { imageKey: await uploadImage(file) } : {}) }; break;
        case "coupon": path = "/coupons"; body = { storeId: values.storeId, roomId: values.roomId, name: values.name, pointsDiscount: values.pointsDiscount, expiresAt: `${values.expiresAt!.format("YYYY-MM-DD")}T23:59:59+08:00` }; break;
        case "user": path = "/users"; body = { ...(values.displayName ? { displayName: values.displayName } : {}), email: values.email, role: values.role, password: values.password }; break;
        case "password": await post(`/users/${entity!.id}/password`, { password: values.password }); return;
      }
      if (entity) await patch(`${path}/${entity.id}`, body); else await post(path, body);
    }, kind === "password" ? "密码已重置，原登录会话已失效" : `${label}已保存`);
    if (ok) { saved?.(); close(); }
  }
  const required = [{ required: true, message: "请填写此项" }];
  return <Modal open title={kind === "password" ? `重置 ${entity && "displayName" in entity ? entity.displayName : ""} 的密码` : `${entity ? "编辑" : "新建"}${label}`} onCancel={() => { if (!data.busy) close(); }} footer={null} destroyOnHidden>
    <Form<Values> layout="vertical" initialValues={initial} onFinish={submit} requiredMark={false} disabled={data.busy}>
      {["room", "product", "coupon"].includes(kind) && <Form.Item name="storeId" label="所属店铺" rules={required}><Select disabled={!!entity} placeholder="选择店铺" options={data.stores.map((s) => ({ value: s.id, label: s.name }))} /></Form.Item>}
      {["store", "product", "coupon"].includes(kind) && <Form.Item name="name" label={`${label}名称`} rules={required}><Input maxLength={kind === "product" ? 100 : 80} /></Form.Item>}
      {["store", "product"].includes(kind) && <Form.Item name="description" label="简介"><Input.TextArea rows={3} maxLength={1000} showCount /></Form.Item>}
      {kind === "room" && <><Form.Item name="title" label="课堂标题" rules={required}><Input maxLength={100} /></Form.Item>{entity && <Form.Item name="status" label="课堂显示状态" extra="“直播中”由 OBS 推流自动更新。直播中请先停止 OBS，结束后再修改状态。"><Select disabled={(entity as Room).status === "LIVE"} options={[{ value: "DRAFT", label: "准备中" }, { value: "READY", label: "待开播" }, { value: "LIVE", label: "直播中（自动）", disabled: true }, { value: "ENDED", label: "标记已结束" }]} /></Form.Item>}</>}
      {kind === "product" && <><Form.Item name="pointsPrice" label="兑换所需积分" rules={required}><InputNumber min={1} max={1_000_000} precision={0} className="full-width" /></Form.Item><Form.Item name="pickupPoint" label="自提点" rules={required} extra="学生选择自提后，订单中会显示这里填写的地点。"><Input maxLength={200} /></Form.Item><Form.Item label="商品图片" extra="JPG / PNG / WebP，最大 3 MB；编辑时不选择图片将保留原图。"><Upload accept="image/jpeg,image/png,image/webp" maxCount={1} beforeUpload={(next) => { if (next.size > 3_000_000) { void data.run(async () => { throw new Error("图片不能超过 3 MB"); }); return Upload.LIST_IGNORE; } setFile(next); return false; }} onRemove={() => setFile(undefined)}><Button icon={<UploadOutlined />}>选择图片</Button></Upload></Form.Item></>}
      {kind === "coupon" && <><Form.Item name="roomId" label="适用直播间" rules={required}><Select placeholder="选择直播间" options={data.rooms.map((room) => ({ value: room.id, label: `${room.store.name} / ${room.title}` }))} /></Form.Item><Form.Item name="pointsDiscount" label="抵扣积分" rules={required}><InputNumber min={1} max={1_000_000} precision={0} className="full-width" /></Form.Item><Form.Item name="expiresAt" label="到期日期（北京时间）" rules={required}><DatePicker className="full-width" /></Form.Item></>}
      {kind === "user" && <><Form.Item name="displayName" label="姓名（选填）" extra="不填写时默认使用账号作为姓名。"><Input maxLength={80} /></Form.Item><Form.Item name="email" label="登录账号" rules={[...required, { pattern: /^[a-zA-Z0-9._@-]{2,100}$/, message: "仅支持字母、数字、点、下划线、@、中划线" }]}><Input maxLength={100} autoComplete="off" placeholder="学号 / 工号 / 邮箱" /></Form.Item><Form.Item name="role" label="角色" rules={required}><Select options={[{ value: "STUDENT", label: "学生" }, { value: "TEACHER", label: "教师" }]} /></Form.Item></>}
      {["user", "password"].includes(kind) && <Form.Item name="password" initialValue={kind === "user" ? "123456" : undefined} label={kind === "password" ? "新密码" : "初始密码"} rules={[...required, { min: 6, message: "至少 6 位" }]} extra="默认初始密码 123456；账号首次登录或重置后必须修改密码。"><Input.Password minLength={6} maxLength={200} autoComplete="new-password" /></Form.Item>}
      <div className="modal-actions"><Button onClick={close}>取消</Button><Button type="primary" htmlType="submit" loading={data.busy}>保存{label}</Button></div>
    </Form>
  </Modal>;
}
