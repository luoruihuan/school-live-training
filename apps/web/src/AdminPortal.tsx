import { useState } from "react";
import { Alert, Avatar, Button, Drawer, Layout, Menu, Space, Spin, Tag } from "antd";
import { DashboardOutlined, GiftOutlined, HistoryOutlined, LogoutOutlined, MenuOutlined, MonitorOutlined, PlaySquareFilled, ProfileOutlined, SettingOutlined, ShopOutlined, ShoppingOutlined, TeamOutlined, VideoCameraOutlined } from "@ant-design/icons";
import type { User } from "./api";
import { usePlatform } from "./usePlatform";
import { Management, type ManageTab } from "./Management";
import { Accounts, StaffOrders } from "./AdminRecords";
import { PointsManagement } from "./PointsManagement";
import { AdminOverview } from "./AdminOverview";
import { OpsMonitor } from "./OpsMonitor";
import { OpsSettings } from "./OpsSettings";
import { AuditLogs } from "./AuditLogs";
import { PageTitle } from "./ui";

type Tab = "overview" | ManageTab | "orders" | "accounts" | "points" | "monitor" | "ops" | "logs";
const superAdminOnly: Tab[] = ["monitor", "ops", "logs"];
const pages: { key: Tab; label: string; icon: React.ReactNode; description: string }[] = [
  { key: "overview", label: "教学概览", icon: <DashboardOutlined />, description: "课堂准备、直播教学与日常管理，从这里开始。" },
  { key: "rooms", label: "直播间管理", icon: <VideoCameraOutlined />, description: "维护课堂、配置本场商品，获取教师专用推流信息。" },
  { key: "stores", label: "店铺管理", icon: <ShopOutlined />, description: "使用统一店铺模板，维护学校实训店铺的基础资料。" },
  { key: "products", label: "商品管理", icon: <ShoppingOutlined />, description: "维护商品、兑换积分、自提点与上下架状态。" },
  { key: "coupons", label: "优惠券", icon: <GiftOutlined />, description: "按直播间配置优惠券，供学生兑换时抵扣积分。" },
  { key: "orders", label: "兑换订单", icon: <ProfileOutlined />, description: "查询积分兑换订单，核对自提或送货信息。" },
  { key: "accounts", label: "账号管理", icon: <TeamOutlined />, description: "创建师生账号、重置密码或停用访问。" },
  { key: "points", label: "积分管理", icon: <GiftOutlined />, description: "给师生增加、扣减或设置积分，查看分页流水。" },
  { key: "monitor", label: "运行监控", icon: <MonitorOutlined />, description: "直播、服务与存储的当前状态，异常排在最前面（仅超级管理员）。" },
  { key: "ops", label: "系统设置", icon: <SettingOutlined />, description: "直播线路与分发开关，改动会记入操作日志（仅超级管理员）。" },
  { key: "logs", label: "操作日志", icon: <HistoryOutlined />, description: "谁在什么时候改了什么，可按动作筛选（仅超级管理员）。" }
];

export default function AdminPortal({ user, logout }: { user: User; logout: () => Promise<void> }) {
  const [tab, setTab] = useState<Tab>("overview");
  const [mobileMenu, setMobileMenu] = useState(false);
  const data = usePlatform();
  const page = pages.find((p) => p.key === tab)!;
  const allowed = pages.filter((p) => {
    if (superAdminOnly.includes(p.key)) return user.role === "SUPER_ADMIN";
    if (p.key === "accounts" || p.key === "points") return ["ADMIN", "SUPER_ADMIN"].includes(user.role);
    return true;
  });
  const group = (label: string, keys: Tab[]) => ({ type: "group" as const, label, children: allowed.filter((page) => keys.includes(page.key)).map(({ key, label: name, icon }) => ({ key, label: name, icon })) });
  const menu = <Menu theme="dark" mode="inline" selectedKeys={[tab]} onClick={({ key }) => { setTab(key as Tab); setMobileMenu(false); void data.refresh().catch(() => undefined); }} items={[
    group("直播教学", ["overview", "rooms"]), group("商品与兑换", ["stores", "products", "coupons", "orders"]),
    group("人员管理", ["accounts", "points"]), group("系统", ["monitor", "ops", "logs"])
  ].filter((item) => item.children.length)} />;
  return <Layout className="admin-shell">
    <Layout.Sider width={228} className="admin-sidebar"><a className="brand brand--inverse" href="/admin"><PlaySquareFilled /><span>校园直播<span className="brand-sub">TEACHING CONSOLE</span></span></a><div className="admin-sidebar__label">教学管理工作台</div>{menu}<div className="admin-sidebar__foot"><Tag color="blue">单校实训平台</Tag><p>课堂与业务，统一管理。</p></div></Layout.Sider>
    <Layout><Layout.Header className="admin-header"><Space><Button className="admin-menu-toggle" icon={<MenuOutlined />} aria-label="展开管理菜单" onClick={() => setMobileMenu(true)} /><span className="muted">教学工作台 /</span><strong>{page.label}</strong></Space><Space><Tag>教学工作台</Tag><Avatar size="small" style={{ background: "#3263dc" }}>{user.displayName.slice(0, 1)}</Avatar><span className="admin-name">{user.displayName} · {user.role === "SUPER_ADMIN" ? "超级管理员" : user.role === "ADMIN" ? "管理员" : "教师"}</span><Button type="text" icon={<LogoutOutlined />} aria-label="退出登录" onClick={() => void logout()} /></Space></Layout.Header>
      <Layout.Content className="admin-content"><div className="admin-title"><PageTitle label="CAMPUS / CONSOLE" title={page.label} description={page.description} /></div>
        {data.error && <Alert type="error" title={data.error} showIcon className="spaced" />}
        {data.loading ? <div className="loading-panel"><Spin /></div> : <>
          {tab === "overview" && <AdminOverview data={data} navigate={setTab} />}
          {(["rooms", "stores", "products", "coupons"] as Tab[]).includes(tab) && <Management key={tab} tab={tab as ManageTab} data={data} onNavigate={setTab} />}
          {tab === "orders" && <StaffOrders />}{tab === "accounts" && ["ADMIN", "SUPER_ADMIN"].includes(user.role) && <Accounts data={data} />}
          {tab === "points" && ["ADMIN", "SUPER_ADMIN"].includes(user.role) && <PointsManagement />}
          {tab === "monitor" && user.role === "SUPER_ADMIN" && <OpsMonitor />}
          {tab === "ops" && user.role === "SUPER_ADMIN" && <OpsSettings />}
          {tab === "logs" && user.role === "SUPER_ADMIN" && <AuditLogs />}
        </>}
      </Layout.Content><footer className="admin-footer">校园直播实训平台 · 管理工作台</footer></Layout>
    <Drawer title="教学工作台" open={mobileMenu} onClose={() => setMobileMenu(false)} placement="left" styles={{ body: { padding: 0, background: "#001529" } }}>{menu}</Drawer>
  </Layout>;
}
