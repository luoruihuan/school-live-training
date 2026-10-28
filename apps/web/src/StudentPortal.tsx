import { lazy, Suspense, useEffect, useRef, useState } from "react";
import { Alert, App, Avatar, Badge, Button, Card, Drawer, Input, InputNumber, Pagination, Popconfirm, Segmented, Select, Space, Spin, Tag, Typography } from "antd";
import { ArrowLeftOutlined, ArrowRightOutlined, HistoryOutlined, LogoutOutlined, PlayCircleOutlined, PlaySquareFilled, ProfileOutlined, ReloadOutlined, ShareAltOutlined, ShoppingCartOutlined } from "@ant-design/icons";
import { api, ApiError, pointText, patch, post, type Product, type User } from "./api";
import { usePlatform } from "./usePlatform";
import { NoData, PageTitle, ProductImage, RoomStatus } from "./ui";
import { Chat } from "./Chat";
import { Replay } from "./Replay";

const Player = lazy(() => import("./Player").then((m) => ({ default: m.Player })));
type Tab = "rooms" | "replays" | "cart" | "orders";
const tabs = [
  { key: "rooms" as const, label: "直播课堂", icon: <PlayCircleOutlined /> },
  { key: "replays" as const, label: "课程回放", icon: <HistoryOutlined /> },
  { key: "cart" as const, label: "购物车", icon: <ShoppingCartOutlined /> },
  { key: "orders" as const, label: "我的订单", icon: <ProfileOutlined /> }
];

function CartQuantity({ name, quantity, disabled, save }: { name: string; quantity: number; disabled: boolean; save: (value: number) => Promise<boolean> }) {
  const [value, setValue] = useState<number | null>(quantity);
  useEffect(() => setValue(quantity), [quantity]);
  async function commit(next: number | null) {
    if (next === null) { setValue(quantity); return; }
    if (next !== quantity && !await save(next)) setValue(quantity);
  }
  return <InputNumber aria-label={`${name}数量`} min={1} max={99} precision={0} value={value} disabled={disabled} onChange={setValue} onBlur={() => void commit(value)} onStep={(next) => void commit(next)} />;
}

export default function StudentPortal({ user, logout }: { user: User; logout: () => Promise<void> }) {
  const data = usePlatform();
  const { message } = App.useApp();
  const [tab, setTab] = useState<Tab>(() => new URLSearchParams(location.search).get("view") === "replay" ? "replays" : "rooms");
  const [roomId, setRoomId] = useState<string | null>(() => new URLSearchParams(location.search).get("room"));
  const [roomProducts, setRoomProducts] = useState<Product[]>([]);
  const [roomError, setRoomError] = useState("");
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState("全部课堂");
  const [drawer, setDrawer] = useState(false);
  const [shopSection, setShopSection] = useState<"products" | "coupons" | "selected">("products");
  const [checkoutOpen, setCheckoutOpen] = useState(false);
  const [couponId, setCouponId] = useState<string>();
  const [fulfillmentMethod, setFulfillmentMethod] = useState<"PICKUP" | "DELIVERY">("PICKUP");
  const [deliveryAddress, setDeliveryAddress] = useState("");
  const requestKey = useRef<string | null>(null);
  const room = data.rooms.find((r) => r.id === roomId);
  const cartCount = data.cart.reduce((n, item) => n + item.quantity, 0);
  const subtotal = data.cart.reduce((sum, item) => sum + item.product.pointsPrice * item.quantity, 0);
  const eligibleCoupons = data.myCoupons.filter((c) => !c.usedAt && new Date(c.coupon.expiresAt).getTime() > Date.now() && data.cart.some((i) => i.product.storeId === c.coupon.storeId && i.product.roomIds.includes(c.coupon.roomId)));
  const selectedCoupon = eligibleCoupons.find((c) => c.couponId === couponId)?.coupon;
  const discount = selectedCoupon ? Math.min(selectedCoupon.pointsDiscount, data.cart.filter((i) => i.product.storeId === selectedCoupon.storeId && i.product.roomIds.includes(selectedCoupon.roomId)).reduce((sum, i) => sum + i.product.pointsPrice * i.quantity, 0)) : 0;

  function selectRoom(id: string | null) {
    setRoomId(id); setDrawer(false);
    const url = new URL(location.href);
    if (id) url.searchParams.set("room", id); else url.searchParams.delete("room");
    history.replaceState(null, "", url);
  }
  function navigate(next: Tab) {
    setTab(next); selectRoom(null); setSearch("");
    const url = new URL(location.href);
    if (next === "replays") url.searchParams.set("view", "replay"); else url.searchParams.delete("view");
    history.replaceState(null, "", url);
  }
  function showRoomReplay() {
    setTab("replays");
    const url = new URL(location.href);
    url.searchParams.set("view", "replay");
    history.replaceState(null, "", url);
  }
  function goToTab(next: Tab) {
    if (next === "cart" && tab === "rooms" && roomId) { setShopSection("selected"); setDrawer(true); return; }
    navigate(next);
  }
  function openShop(section: "products" | "coupons" | "selected") { setShopSection(section); setDrawer(true); }
  useEffect(() => {
    if (!roomId) { setRoomProducts([]); return; }
    let active = true;
    setRoomError(""); setRoomProducts([]);
    api<Product[]>(`/rooms/${roomId}/products`).then((items) => { if (active) setRoomProducts(items.filter((p) => p.isActive)); })
      .catch((e: unknown) => { if (active) setRoomError(e instanceof Error ? e.message : "读取商品失败"); });
    return () => { active = false; };
  }, [roomId, data.products]);

  async function checkout() {
    if (fulfillmentMethod === "DELIVERY" && !deliveryAddress.trim()) { void message.error("请填写送货地点"); return; }
    requestKey.current ??= crypto.randomUUID();
    const ok = await data.run(async () => {
      try { await post("/orders", { requestKey: requestKey.current, couponId: selectedCoupon?.id, expectedPointsTotal: subtotal - discount, fulfillmentMethod, deliveryAddress: fulfillmentMethod === "DELIVERY" ? deliveryAddress.trim() : undefined }); }
      catch (e) {
        if (e instanceof ApiError && e.status < 500) { requestKey.current = null; throw e; }
        throw new Error("未能确认提交结果，请先到我的订单核对；未修改购物车时可直接重试，不会重复下单。");
      }
    }, "积分兑换成功", data.refreshCheckout);
    if (ok) { requestKey.current = null; setCouponId(undefined); navigate("orders"); }
  }
  function changeCart(action: () => Promise<unknown>, success: string) {
    return data.run(async () => {
      // 新购物操作开始新的结算；原单结果未知时，只对未修改的购物车复用提交标识。
      requestKey.current = null;
      await action();
    }, success, data.refreshCart);
  }
  function products() {
    return <div className="shop-products">{roomProducts.map((p) => <Card size="small" key={p.id} className="shop-product">
      <ProductImage product={p} /><div className="shop-product__body"><h3>{p.name}</h3><p className="muted">{p.description || "课堂实训商品"}</p><p className="muted small">可选择自提或送货</p><div className="split"><strong className="price">{pointText(p.pointsPrice)}</strong><Button type="primary" size="small" icon={<ShoppingCartOutlined />} disabled={data.busy} onClick={() => void changeCart(() => post("/cart", { productId: p.id }), "已加入已选商品")}>加入</Button></div></div>
    </Card>)}{!roomProducts.length && <NoData text="本场暂无商品" />}</div>;
  }
  function roomCoupons() {
    const coupons = data.coupons.filter((coupon) => coupon.roomId === roomId);
    return <div className="coupon-list">{coupons.map((coupon) => {
      const claimed = data.myCoupons.find((mine) => mine.couponId === coupon.id);
      return <div className="coupon-item" key={coupon.id}><strong>−{pointText(coupon.pointsDiscount)}</strong><div><b>{coupon.name}</b><small>有效至 {new Date(coupon.expiresAt).toLocaleDateString("zh-CN")}</small></div><Button size="small" disabled={!!claimed || data.busy} onClick={() => void data.run(() => post(`/coupons/${coupon.id}/claim`, {}), "优惠券已领取", data.refreshCoupons)}>{claimed ? claimed.usedAt ? "已使用" : "已领取" : "领取"}</Button></div>;
    })}{!coupons.length && <NoData text="本场暂无优惠券" />}</div>;
  }
  function cartItems() {
    return data.cart.map((item) => <div className="cart-item" key={item.productId}><ProductImage product={item.product} /><div className="cart-item__name"><strong>{item.product.name}</strong><span className="muted">{pointText(item.product.pointsPrice)} / 件</span><span className="muted small">自提点：{item.product.pickupPoint}</span>{!item.product.isActive && <Tag color="red">已下架，请移除</Tag>}</div><CartQuantity name={item.product.name} quantity={item.quantity} disabled={data.busy || !item.product.isActive} save={(quantity) => changeCart(() => patch(`/cart/${item.productId}`, { quantity }), "数量已更新")} /><strong>{pointText(item.quantity * item.product.pointsPrice)}</strong><Popconfirm title="从已选商品移除这件商品？" onConfirm={() => changeCart(() => api(`/cart/${item.productId}`, { method: "DELETE" }), "已移除")}><Button type="text" danger disabled={data.busy}>移除</Button></Popconfirm></div>);
  }
  function checkoutForm() {
    return <Card className="checkout-card"><div className="checkout-items">{data.cart.map((item) => <div className="split" key={item.productId}><span>{item.product.name} × {item.quantity}</span><b>{pointText(item.product.pointsPrice * item.quantity)}</b></div>)}</div><div className="split spaced-top"><span>积分余额</span><b>{pointText(data.points.balance)}</b></div><div className="split spaced-top"><span>商品所需</span><b>{pointText(subtotal)}</b></div><div className="spaced-top"><label htmlFor="checkout-coupon">使用已领取的优惠券</label><Select id="checkout-coupon" className="full-width spaced-top" placeholder="选择优惠券" allowClear disabled={data.busy} value={selectedCoupon?.id} onChange={(value) => { requestKey.current = null; setCouponId(value); }} options={eligibleCoupons.map((c) => ({ value: c.couponId, label: `${c.coupon.name} · 减 ${pointText(c.coupon.pointsDiscount)}` }))} />{!eligibleCoupons.length && <p className="small muted">暂无适用券，可在直播间领取。</p>}</div><div className="split spaced-top"><span>优惠抵扣</span><span>−{pointText(discount)}</span></div><div className="spaced-top"><label htmlFor="fulfillment-method">交付方式</label><Select id="fulfillment-method" className="full-width spaced-top" value={fulfillmentMethod} onChange={(value) => { requestKey.current = null; setFulfillmentMethod(value); }} options={[{ value: "PICKUP", label: "自提（默认）" }, { value: "DELIVERY", label: "送货" }]} /></div>{fulfillmentMethod === "DELIVERY" ? <div className="spaced-top"><label htmlFor="delivery-address">送货地点</label><Input id="delivery-address" className="spaced-top" value={deliveryAddress} onChange={(event) => { requestKey.current = null; setDeliveryAddress(event.target.value); }} maxLength={200} placeholder="请填写楼栋、房间或约定地点" /></div> : <p className="small muted">自提点：{[...new Set(data.cart.map((item) => item.product.pickupPoint))].join("；")}</p>}<div className="checkout-total split"><span>实际扣除</span><strong>{pointText(subtotal - discount)}</strong></div><Button block type="primary" size="large" loading={data.busy} disabled={!data.cart.length || data.cart.some((i) => !i.product.isActive) || data.points.balance < subtotal - discount || (fulfillmentMethod === "DELIVERY" && !deliveryAddress.trim())} onClick={() => void checkout()}>确认积分兑换</Button>{fulfillmentMethod === "DELIVERY" && !deliveryAddress.trim() && <p className="small muted">请填写送货地点。</p>}{data.points.balance < subtotal - discount && <p className="small muted">积分不足，请联系管理员充值。</p>}</Card>;
  }
  const visibleRooms = data.rooms.filter((r) => (r.status !== "DRAFT" || user.role !== "STUDENT") && `${r.title}${r.store.name}`.includes(search) && (tab === "replays" ? r.recordingCount > 0 : filter === "全部课堂" || (filter === "正在直播" ? r.status === "LIVE" : r.status === "READY")));

  return <div className="student-shell">
    <header className="student-header"><a href="/" className="brand"><PlaySquareFilled /><span>校园直播<span className="brand-sub">CAMPUS LIVE</span></span></a>
      <nav className="student-nav" aria-label="学生导航">{tabs.map((t) => <Button key={t.key} type={tab === t.key ? "primary" : "text"} icon={t.icon} onClick={() => goToTab(t.key)}>{t.label}{t.key === "cart" && cartCount > 0 && <Badge count={cartCount} color="#c4753d" />}</Button>)}</nav>
      <Space><Tag color="green">余额 {pointText(data.points.balance)}</Tag><Avatar style={{ background: "#e1ebe2", color: "#176b53" }}>{user.displayName.slice(0, 1)}</Avatar><span className="student-name">{user.displayName}</span><Button type="text" icon={<LogoutOutlined />} aria-label="退出登录" onClick={() => void logout()} /></Space>
    </header>
    <main className="student-content">
      {data.error && <Alert type="error" showIcon title={data.error} action={<Button size="small" onClick={() => void data.run(data.refresh, "已刷新")}>重试</Button>} className="spaced" />}
      {data.loading ? <div className="loading-panel"><Spin /></div> : <>
        {(tab === "rooms" || tab === "replays") && !roomId && <>
          {tab === "rooms" ? <section className="student-hero"><div><h1>直播课堂</h1><p>{data.rooms.some((r) => r.status === "LIVE") ? "课程正在直播，进入课堂参与互动。" : "当前没有正在直播的课堂，可查看待开播课程。"}</p><Tag color="green">{data.rooms.filter((r) => r.status === "LIVE").length} 间正在直播</Tag></div><div className="hero-illustration" aria-hidden="true"><div className="hero-illustration__screen"><PlayCircleOutlined /><span>课堂实训</span></div></div></section> : <PageTitle label="COURSE REPLAY" title="复习已录制的课堂" description="只展示已有录制、目前可观看的课堂。" />}
          <div className="section-toolbar"><div><h2>{tab === "rooms" ? "发现课堂" : "课程回放"}</h2><span className="muted">{visibleRooms.length} 间课堂</span></div><Space wrap>{tab === "rooms" && <Segmented options={["全部课堂", "正在直播", "待开播"]} value={filter} onChange={setFilter} />}<Input.Search aria-label="搜索课堂" placeholder="搜索课堂或店铺" value={search} allowClear onChange={(e) => setSearch(e.target.value)} className="class-search" /><Button icon={<ReloadOutlined />} aria-label="刷新课堂" onClick={() => void data.run(data.refresh, "课堂已刷新")} /></Space></div>
          <div className="class-grid">{visibleRooms.map((r, index) => <Card key={r.id} hoverable className="class-card" onClick={() => selectRoom(r.id)} cover={<div className={`class-cover class-cover--${index % 3}`}><div className="class-cover__top"><span>{r.store.name}</span><RoomStatus status={r.status} /></div><PlayCircleOutlined /><span className="class-cover__caption">{tab === "replays" ? `${r.recordingCount} 条回放` : "进入课堂"}</span></div>}>
            <div className="muted small">直播实训 · {r.store.name}</div><h3>{r.title}</h3><div className="split"><span className="muted small">{tab === "replays" ? "课程录制" : "观看与课堂互动"}</span><Button type="text" icon={<ArrowRightOutlined />} onClick={() => selectRoom(r.id)}>{tab === "replays" ? "查看回放" : "进入课堂"}</Button></div>
          </Card>)}</div>{!visibleRooms.length && <NoData text={search ? "没有找到匹配的课堂" : tab === "replays" ? "暂无可观看的课程回放" : "暂无课堂，请等待教师发布"} />}
        </>}

        {(tab === "rooms" || tab === "replays") && roomId && <>
          <Button type="text" icon={<ArrowLeftOutlined />} onClick={() => selectRoom(null)}>返回{tab === "rooms" ? "课堂" : "回放"}列表</Button>
          {room ? <><div className="watch-heading"><div><Space><RoomStatus status={room.status} /><span className="muted">{room.store.name}</span></Space><h1>{room.title}</h1></div><Space wrap><Button icon={<ShareAltOutlined />} onClick={() => void navigator.clipboard.writeText(`${location.origin}/?room=${room.id}`).then(() => message.success("课堂链接已复制")).catch(() => message.error("复制失败，请复制浏览器地址"))}>分享课堂</Button><Button icon={<ShoppingCartOutlined />} onClick={() => openShop("selected")}>已选商品 {cartCount || ""}</Button></Space></div>
            {tab === "replays" ? <Card><Replay key={room.id} roomId={room.id} /></Card> : <div className="watch-grid"><div><Card className="video-card"><Suspense fallback={<Spin />}><Player key={room.id} roomId={room.id} /></Suspense></Card><div className="live-action-bar"><Button icon={<ShoppingCartOutlined />} onClick={() => openShop("products")}>本场商品 {roomProducts.length}</Button><Button onClick={() => openShop("coupons")}>领券</Button><Button type="primary" onClick={() => openShop("selected")}>已选 {cartCount}</Button></div><Card className="spaced-top"><Chat key={room.id} roomId={room.id} canModerate={user.role !== "STUDENT"} /></Card></div><aside className="watch-shop"><Card title={<Space><ShoppingCartOutlined /> 本场商品 <Tag>{roomProducts.length}</Tag></Space>}>{roomError && <Alert type="error" title={roomError} />}{products()}</Card><Card className="spaced-top" title="本场优惠券">{roomCoupons()}</Card><Button block type="primary" className="spaced-top" disabled={!data.cart.length} onClick={() => setCheckoutOpen(true)}>已选 {cartCount} 件 · 去兑换</Button>{room.recordingCount > 0 && <Button block className="spaced-top" icon={<HistoryOutlined />} onClick={showRoomReplay}>查看本场回放</Button>}</aside></div>}
          </> : <NoData text="课堂不存在或暂不可见" />}
        </>}

        {tab === "cart" && <>
          <PageTitle label="PRACTICE CART" title="已选商品" description="在这里调整商品数量；确认兑换时再选择优惠券与交付方式。" />
          <div className="cart-layout"><Card>{cartItems()}{!data.cart.length && <><NoData text="还没有选商品，去课堂看看吧" /><Button block onClick={() => navigate("rooms")}>去看直播课堂</Button></>}</Card>
            <Card title="本次已选" className="cart-summary"><div className="split"><span>商品数量</span><b>{cartCount} 件</b></div><div className="split spaced-top"><span>所需积分</span><strong>{pointText(subtotal)}</strong></div><Button block type="primary" className="spaced-top" disabled={!data.cart.length} onClick={() => setCheckoutOpen(true)}>去兑换</Button></Card></div>
        </>}

        {tab === "orders" && <><PageTitle label="MY PRACTICE" title="我的兑换订单" description="查看积分扣减、交付方式与商品自提点。" /><div className="order-list">{data.orders.map((order) => <Card key={order.id} title={<Space wrap><span>订单 {order.id.slice(-8).toUpperCase()}</span><Tag color={order.status === "COMPLETED" ? "green" : "blue"}>{order.status === "COMPLETED" ? "已完成" : order.fulfillmentMethod === "PICKUP" ? "待自提" : "待送货"}</Tag></Space>} extra={<span className="muted small">{new Date(order.createdAt).toLocaleString("zh-CN")}</span>}><Typography.Text type="secondary" copyable={{ text: order.id }}>订单编号：{order.id}</Typography.Text>{order.items.map((item) => <div className="order-item split" key={item.id}><span>{item.name}<span className="muted"> × {item.quantity}</span>{order.fulfillmentMethod === "PICKUP" && <span className="muted small"> · 自提点：{item.pickupPoint}</span>}</span><strong>{pointText(item.pointsPrice * item.quantity)}</strong></div>)}{order.fulfillmentMethod === "DELIVERY" && <p>送货地点：{order.deliveryAddress}</p>}<div className="order-total split"><span className="muted">{order.pointsDiscount ? `优惠 ${pointText(order.pointsDiscount)}` : "未使用优惠券"}</span><span>已扣 <strong className="price">{pointText(order.pointsTotal)}</strong></span></div></Card>)}</div>{data.orderTotal > 20 && <Pagination current={data.orderPage} total={data.orderTotal} pageSize={20} showSizeChanger={false} onChange={(page) => void data.loadOrders(page).catch(() => message.error("订单加载失败，请重试"))} />}{!data.orders.length && <NoData text="还没有兑换订单" />}</>}
      </>}
      <footer className="student-footer"><span>校园直播实训 · 在实践中成长</span><span>积分兑换不涉及在线支付</span></footer>
    </main>
    <nav className="student-bottom-nav" aria-label="移动端学生导航">{tabs.map((t) => <Button key={t.key} type="text" className={tab === t.key ? "is-active" : ""} onClick={() => goToTab(t.key)}>{t.icon}<span>{t.label}</span></Button>)}</nav>
    <Drawer title="本场小黄车" open={drawer} onClose={() => setDrawer(false)} placement="bottom" size="large" styles={{ wrapper: { height: "72vh" } }}>
      <Segmented block options={[{ label: `商品 ${roomProducts.length}`, value: "products" }, { label: "领券", value: "coupons" }, { label: `已选 ${cartCount}`, value: "selected" }]} value={shopSection} onChange={setShopSection} />
      <div className="shop-drawer-content">{shopSection === "products" && <>{roomError && <Alert type="error" title={roomError} />}{products()}</>}{shopSection === "coupons" && roomCoupons()}{shopSection === "selected" && <>{cartItems()}{!data.cart.length && <NoData text="还没有选商品" />}</>}</div>
      <div className="shop-drawer-footer"><span>已选 {cartCount} 件 · {pointText(subtotal)}</span><Button type="primary" disabled={!data.cart.length} onClick={() => { setDrawer(false); setCheckoutOpen(true); }}>去兑换</Button></div>
    </Drawer>
    <Drawer title="确认积分兑换" open={checkoutOpen} onClose={() => setCheckoutOpen(false)} placement="right" size="min(460px, 100vw)">{checkoutForm()}</Drawer>
  </div>;
}
