export type Role = "SUPER_ADMIN" | "ADMIN" | "TEACHER" | "STUDENT";
export type User = { id: string; email: string; displayName: string; role: Role; mustChangePassword: boolean };
export type ManagedUser = User & { isActive: boolean; pointsBalance: number; createdAt: string; isTest?: boolean };
export type Store = { id: string; name: string; description: string; isTest?: boolean };
export type Room = {
  id: string;
  storeId: string;
  title: string;
  isTest?: boolean;
  status: "DRAFT" | "READY" | "LIVE" | "ENDED";
  productCount: number;
  couponCount: number;
  recordingCount: number;
  store: { id: string; name: string };
};
export type Product = {
  id: string;
  storeId: string;
  name: string;
  isTest?: boolean;
  description: string;
  pointsPrice: number;
  pickupPoint: string;
  imageUrl: string | null;
  imageKey?: string | null;
  detailImageKeys?: string[];
  position?: number;
  isActive: boolean;
};
export type CartItem = { productId: string; quantity: number; product: Product & { roomIds: string[] } };
export type Coupon = { id: string; storeId: string; roomId: string; name: string; isTest?: boolean; pointsDiscount: number; expiresAt: string; store: { name: string }; room: { title: string } };
export type UserCoupon = { id: string; couponId: string; usedAt: string | null; coupon: Omit<Coupon, "store" | "room"> };
export type PointEntry = { id: string; delta: number; balanceAfter: number; reason: string; createdAt: string };
export type Points = { balance: number; entries: PointEntry[] };
export type Order = {
  id: string;
  pointsSubtotal: number;
  pointsDiscount: number;
  pointsTotal: number;
  fulfillmentMethod: "PICKUP" | "DELIVERY";
  deliveryAddress: string | null;
  status: "PENDING_PICKUP" | "PENDING_DELIVERY" | "COMPLETED";
  createdAt: string;
  items: { id: string; name: string; pointsPrice: number; pickupPoint: string; quantity: number }[];
  coupon: { name: string } | null;
  user?: Pick<User, "id" | "email" | "displayName">;
};
export type OrderPage = { items: Order[]; total: number; page: number; pageSize: number };

export class ApiError extends Error {
  constructor(message: string, public readonly status: number) { super(message); }
}

export async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`/api${path}`, {
    ...init,
    credentials: "same-origin",
    headers: { "Content-Type": "application/json", "X-School-Live-Request": "1", ...init?.headers }
  });
  if (!response.ok) {
    let message = `请求失败（${response.status}）`;
    try {
      const body: { message?: string | string[] } = await response.json();
      if (body.message) message = Array.isArray(body.message) ? body.message.join("；") : body.message;
    } catch { /* 保留 HTTP 状态信息 */ }
    if (response.status === 401 && !path.startsWith("/auth/")) window.dispatchEvent(new Event("session-expired"));
    throw new ApiError(message, response.status);
  }
  return response.json() as Promise<T>;
}

export function post<T>(path: string, body: unknown): Promise<T> {
  return api<T>(path, { method: "POST", body: JSON.stringify(body) });
}

export function patch<T>(path: string, body: unknown): Promise<T> {
  return api<T>(path, { method: "PATCH", body: JSON.stringify(body) });
}

export async function uploadImage(file: File): Promise<string> {
  const form = new FormData();
  form.set("file", file);
  const response = await fetch("/api/uploads/image", { method: "POST", body: form, credentials: "same-origin", headers: { "X-School-Live-Request": "1" } });
  if (!response.ok) {
    const body: { message?: string } = await response.json().catch(() => ({}));
    throw new Error(body.message ?? `图片上传失败（${response.status}）`);
  }
  const result: { imageKey: string } = await response.json();
  return result.imageKey;
}

/** 通用鉴权文件上传（如 Excel 账号导入），返回解析后的 JSON。 */
export async function uploadJson<T>(path: string, file: File): Promise<T> {
  const form = new FormData();
  form.set("file", file);
  const response = await fetch(`/api${path}`, { method: "POST", body: form, credentials: "same-origin", headers: { "X-School-Live-Request": "1" } });
  const body: T | { message?: string | string[] } = await response.json().catch(() => ({} as T));
  if (!response.ok) {
    const errorBody = body as { message?: string | string[] };
    const text = errorBody.message ? Array.isArray(errorBody.message) ? errorBody.message.join("；") : errorBody.message : `上传失败（${response.status}）`;
    throw new Error(text);
  }
  return body as T;
}

/** 鉴权下载（如 Excel 导入模板），保存为浏览器下载。 */
export async function downloadFile(path: string, filename: string): Promise<void> {
  const response = await fetch(`/api${path}`, { credentials: "same-origin", headers: { "X-School-Live-Request": "1" } });
  if (!response.ok) {
    const body: { message?: string } = await response.json().catch(() => ({}));
    throw new Error(body.message ?? `下载失败（${response.status}）`);
  }
  const blob = await response.blob();
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  URL.revokeObjectURL(url);
}

/** 商品介绍图（详情图）访问地址：按商品 id + 序号，需登录态。 */
export function detailImageUrl(productId: string, index: number): string {
  return `/api/products/${productId}/detail-images/${index}`;
}

export function pointText(value: number): string {
  return `${value} 积分`;
}
