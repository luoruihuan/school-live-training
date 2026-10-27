import { useCallback, useEffect, useRef, useState } from "react";
import { App } from "antd";
import { api, type CartItem, type Coupon, type Order, type OrderPage, type Points, type Product, type Room, type Store, type UserCoupon } from "./api";

export function usePlatform() {
  const { message } = App.useApp();
  const [data, setData] = useState({ stores: [] as Store[], rooms: [] as Room[], products: [] as Product[], cart: [] as CartItem[], coupons: [] as Coupon[], myCoupons: [] as UserCoupon[], orders: [] as Order[], orderTotal: 0, orderPage: 1, points: { balance: 0, entries: [] } as Points });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const locked = useRef(false);
  const refresh = useCallback(async () => {
    const [stores, rooms, products, cart, coupons, myCoupons, orders, points] = await Promise.all([
      api<Store[]>("/stores"), api<Room[]>("/rooms"), api<Product[]>("/products"), api<CartItem[]>("/cart"),
      api<Coupon[]>("/coupons"), api<UserCoupon[]>("/coupons/mine"), api<OrderPage>("/orders?page=1"), api<Points>("/points/me")
    ]);
    setData({ stores, rooms, products, cart, coupons, myCoupons, orders: orders.items, orderTotal: orders.total, orderPage: orders.page, points });
    setError("");
  }, []);
  const refreshCart = useCallback(async () => {
    const cart = await api<CartItem[]>("/cart");
    setData((current) => ({ ...current, cart }));
  }, []);
  const refreshCoupons = useCallback(async () => {
    const myCoupons = await api<UserCoupon[]>("/coupons/mine");
    setData((current) => ({ ...current, myCoupons }));
  }, []);
  const refreshCheckout = useCallback(async () => {
    const [cart, myCoupons, orders, points] = await Promise.all([
      api<CartItem[]>("/cart"), api<UserCoupon[]>("/coupons/mine"), api<OrderPage>("/orders?page=1"), api<Points>("/points/me")
    ]);
    setData((current) => ({ ...current, cart, myCoupons, orders: orders.items, orderTotal: orders.total, orderPage: orders.page, points }));
  }, []);
  const loadOrders = useCallback(async (page: number) => {
    const orders = await api<OrderPage>(`/orders?page=${page}`);
    setData((current) => ({ ...current, orders: orders.items, orderTotal: orders.total, orderPage: orders.page }));
  }, []);
  useEffect(() => { void refresh().catch((e: unknown) => setError(e instanceof Error ? e.message : "加载失败")).finally(() => setLoading(false)); }, [refresh]);
  async function run(action: () => Promise<unknown>, success = "已保存", after = refresh): Promise<boolean> {
    if (locked.current) return false;
    locked.current = true;
    setBusy(true);
    try {
      await action();
      void message.success(success);
      try { if (action !== after) await after(); setError(""); } catch { setError("操作已成功，但列表刷新失败，请点击刷新。"); }
      return true;
    } catch (e) {
      void message.error(e instanceof Error ? e.message : "操作失败，请稍后重试");
      return false;
    } finally { locked.current = false; setBusy(false); }
  }
  return { ...data, loading, error, busy, refresh, refreshCart, refreshCoupons, refreshCheckout, loadOrders, run };
}

export type Platform = ReturnType<typeof usePlatform>;
