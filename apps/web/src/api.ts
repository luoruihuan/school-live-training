export type Role = "ADMIN" | "TEACHER" | "STUDENT";
export type User = { id: string; email: string; displayName: string; role: Role; mustChangePassword: boolean };
export type ManagedUser = User & { isActive: boolean; pointsBalance: number; createdAt: string };
export type Store = { id: string; name: string; description: string };
export type Room = {
  id: string;
  storeId: string;
  title: string;
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
  description: string;
  pointsPrice: number;
  pickupPoint: string;
  imageUrl: string | null;
  imageKey?: string | null;
  position?: number;
  isActive: boolean;
};
export type CartItem = { productId: string; quantity: number; product: Product & { roomIds: string[] } };
export type Coupon = { id: string; storeId: string; roomId: string; name: string; pointsDiscount: number; expiresAt: string; store: { name: string }; room: { title: string } };
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

export function pointText(value: number): string {
  return `${value} 积分`;
}
