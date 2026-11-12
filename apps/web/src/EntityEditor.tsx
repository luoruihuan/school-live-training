import { useRef, useState } from "react";
import { App, Button, DatePicker, Form, Input, InputNumber, Modal, Select, Upload } from "antd";
import { UploadOutlined } from "@ant-design/icons";
import type { Dayjs } from "dayjs";
import type { UploadFile } from "antd";
import { detailImageUrl, patch, post, uploadImage, type ManagedUser, type Product, type Room, type Store } from "./api";
import type { Platform } from "./usePlatform";

export type EditorKind = "store" | "room" | "product" | "coupon" | "user" | "password";
type Values = { name?: string; description?: string; storeId?: string; roomId?: string; title?: string; status?: string; pointsPrice?: number; pickupPoint?: string; pointsDiscount?: number; minSpend?: number; expiresAt?: Dayjs; displayName?: string; email?: string; role?: string; password?: string };
const MAX_DETAIL_IMAGES = 9;
type ImgMeta = { key: string };

export function EntityEditor({ kind, entity, roomId, data, close, saved }: {
  kind: EditorKind; entity?: Store | Room | Product | ManagedUser; roomId?: string; data: Platform; close: () => void; saved?: () => void;
}) {
  const { message } = App.useApp();
  const product = entity && "pointsPrice" in entity ? entity as Product : undefined;
  // 图片选择即上传：选中后立即上传并绑定 imageKey、展示缩略图；保存时只提交已上传的 key。
  // mainKeyRef：undefined=未改动保留原图；string=新上传 key；null=删除已有主图（提交空串清空）
  const mainKeyRef = useRef<string | null | undefined>(undefined);
  const initialMain: UploadFile<ImgMeta>[] = product?.imageUrl ? [{ uid: "main-existing", name: "当前主图", status: "done", url: product.imageUrl, response: { key: product.imageKey ?? "" } }] : [];
  const [mainList, setMainList] = useState<UploadFile<ImgMeta>[]>(initialMain);
  const [detailTouched, setDetailTouched] = useState(false);
  const [detailList, setDetailList] = useState<UploadFile<ImgMeta>[]>((product?.detailImageKeys ?? []).map((key, index): UploadFile<ImgMeta> => ({ uid: key, name: `介绍图 ${index + 1}`, status: "done", url: product ? detailImageUrl(product.id, index) : undefined, response: { key } })));

  function validateImage(next: File): boolean {
    if (next.size > 3_000_000) { void message.error("图片不能超过 3 MB"); return false; }
    return true;
  }

  function uploadNow(raw: File, onDone: (key: string | null) => void): void {
    void uploadImage(raw).then((key) => onDone(key)).catch(() => {
      void message.error(`图片上传失败：${raw.name}`);
      onDone(null);
    });
  }

  function pickMain(next: File): void {
    if (!validateImage(next)) return;
    const uid = `new-${Date.now()}`;
    setMainList([{ uid, name: next.name, status: "uploading" }]);
    uploadNow(next, (key) => {
      if (key) { mainKeyRef.current = key; setMainList([{ uid, name: next.name, status: "done", response: { key } }]); }
      else { mainKeyRef.current = undefined; setMainList(initialMain); }
    });
  }

  function removeMain(file: UploadFile<ImgMeta>): boolean {
    if (file.uid === "main-existing") { mainKeyRef.current = null; setMainList([]); }
    else { mainKeyRef.current = undefined; setMainList(initialMain); }
    return false;
  }

  function pickDetail(next: File): void {
    if (detailList.length >= MAX_DETAIL_IMAGES) { void message.error(`介绍图最多 ${MAX_DETAIL_IMAGES} 张`); return; }
    if (!validateImage(next)) return;
    const uid = `new-${Date.now()}-${next.name}`;
    setDetailTouched(true);
    setDetailList((prev) => [...prev, { uid, name: next.name, status: "uploading" }]);
    uploadNow(next, (key) => {
      setDetailList((prev) => prev.map((f) => f.uid === uid ? (key ? { ...f, status: "done", response: { key } } : { ...f, status: "error" }) : f));
    });
  }

  function removeDetail(file: UploadFile<ImgMeta>): boolean {
    setDetailTouched(true);
    setDetailList((prev) => prev.filter((f) => f.uid !== file.uid));
    return false;
  }
  const label = { store: "店铺", room: "直播间", product: "商品", coupon: "优惠券", user: "教学账号", password: "密码" }[kind];
  const initial = { role: "STUDENT", status: "DRAFT", ...entity, ...(roomId ? { roomId, storeId: data.rooms.find((room) => room.id === roomId)?.storeId } : {}) };
  async function submit(values: Values) {
    const ok = await data.run(async () => {
      let path = "";
      let body: object = values;
      switch (kind) {
        case "store": path = "/stores"; body = { name: values.name, description: values.description ?? "" }; break;
        case "room": path = "/rooms"; body = { title: values.title, ...(entity ? values.status === (entity as Room).status ? {} : { status: values.status } : { storeId: values.storeId }) }; break;
        case "product": {
          if (mainList.some((f) => f.status === "uploading") || detailList.some((f) => f.status === "uploading")) {
            throw new Error("图片还在上传中，请等缩略图出现后再保存");
          }
          const detailKeys = detailList.filter((f) => f.status === "done").map((f) => f.response?.key).filter((key): key is string => Boolean(key));
          path = "/products"; body = { storeId: values.storeId, name: values.name, description: values.description ?? "", pointsPrice: values.pointsPrice, pickupPoint: values.pickupPoint, ...(mainKeyRef.current !== undefined ? { imageKey: mainKeyRef.current ?? "" } : {}), ...(detailTouched ? { detailImages: detailKeys } : {}) }; break;
        }
        case "coupon": path = "/coupons"; body = { storeId: values.storeId, roomId: values.roomId, name: values.name, pointsDiscount: values.pointsDiscount, minSpend: values.minSpend ?? 0, expiresAt: `${values.expiresAt!.format("YYYY-MM-DD")}T23:59:59+08:00` }; break;
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
      {kind === "product" && <><Form.Item name="pointsPrice" label="兑换所需积分" rules={required}><InputNumber min={1} max={1_000_000} precision={0} className="full-width" /></Form.Item><Form.Item name="pickupPoint" label="自提点" rules={required} extra="学生选择自提后，订单中会显示这里填写的地点。"><Input maxLength={200} /></Form.Item><Form.Item label="商品图片（主图）" extra="JPG / PNG / WebP，最大 3 MB；选择后立即上传并显示预览。编辑时不重新选择则保留原图，删除预览图后保存即清空主图。"><Upload accept="image/jpeg,image/png,image/webp" listType="picture-card" maxCount={1} fileList={mainList} beforeUpload={(next) => { pickMain(next); return false; }} onRemove={removeMain}>{mainList.length === 0 && <Button size="small" icon={<UploadOutlined />}>上传主图</Button>}</Upload></Form.Item><Form.Item label={`商品介绍图（${detailList.length}/${MAX_DETAIL_IMAGES} 张）`} extra="展示在商品详情弹层中，按添加顺序排列；选择后立即上传并显示缩略图，保存后生效。单张最大 3 MB。"><Upload accept="image/jpeg,image/png,image/webp" multiple listType="picture-card" fileList={detailList} beforeUpload={(next) => { pickDetail(next); return false; }} onRemove={removeDetail}>{detailList.length < MAX_DETAIL_IMAGES && <Button size="small" icon={<UploadOutlined />}>添加介绍图</Button>}</Upload></Form.Item></>}
      {kind === "coupon" && <><Form.Item name="roomId" label="适用直播间" rules={required}><Select placeholder="选择直播间" options={data.rooms.map((room) => ({ value: room.id, label: `${room.store.name} / ${room.title}` }))} /></Form.Item><Form.Item name="pointsDiscount" label="抵扣积分" rules={required}><InputNumber min={1} max={1_000_000} precision={0} className="full-width" /></Form.Item><Form.Item name="minSpend" label="满减门槛（积分）" initialValue={0} extra="适用商品合计达到该积分才能使用此券抵扣；0 为无门槛，任何订单可用。"><InputNumber min={0} max={1_000_000} precision={0} className="full-width" /></Form.Item><Form.Item name="expiresAt" label="到期日期（北京时间）" rules={required}><DatePicker className="full-width" /></Form.Item></>}
      {kind === "user" && <><Form.Item name="displayName" label="姓名（选填）" extra="不填写时默认使用账号作为姓名。"><Input maxLength={80} /></Form.Item><Form.Item name="email" label="登录账号" rules={[...required, { pattern: /^[a-zA-Z0-9._@-]{2,100}$/, message: "仅支持字母、数字、点、下划线、@、中划线" }]}><Input maxLength={100} autoComplete="off" placeholder="学号 / 工号 / 邮箱" /></Form.Item><Form.Item name="role" label="角色" rules={required}><Select options={[{ value: "STUDENT", label: "学生" }, { value: "TEACHER", label: "教师" }]} /></Form.Item></>}
      {["user", "password"].includes(kind) && <Form.Item name="password" initialValue={kind === "user" ? "123456" : undefined} label={kind === "password" ? "新密码" : "初始密码"} rules={[...required, { min: 6, message: "至少 6 位" }]} extra="默认初始密码 123456；账号首次登录或重置后必须修改密码。"><Input.Password minLength={6} maxLength={200} autoComplete="new-password" /></Form.Item>}
      <div className="modal-actions"><Button onClick={close}>取消</Button><Button type="primary" htmlType="submit" loading={data.busy}>保存{label}</Button></div>
    </Form>
  </Modal>;
}
