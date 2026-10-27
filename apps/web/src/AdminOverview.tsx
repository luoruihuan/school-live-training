import { useEffect, useState } from "react";
import { Button, Card, Statistic, Tag } from "antd";
import { ArrowRightOutlined } from "@ant-design/icons";
import { api } from "./api";
import type { Platform } from "./usePlatform";
import { RoomStatus } from "./ui";

type Destination = "rooms" | "stores" | "products" | "orders" | "cloud";

export function AdminOverview({ data, isAdmin, navigate }: { data: Platform; isAdmin: boolean; navigate: (tab: Destination) => void }) {
  const [pendingOrders, setPendingOrders] = useState<number>();
  const [cloudConfigured, setCloudConfigured] = useState<boolean>();
  useEffect(() => {
    let active = true;
    api<{ pendingOrders: number }>("/staff/overview").then((value) => { if (active) setPendingOrders(value.pendingOrders); }).catch(() => { if (active) setPendingOrders(undefined); });
    return () => { active = false; };
  }, []);
  useEffect(() => {
    if (!isAdmin) return;
    let active = true;
    api<{ settings: { configured: boolean }[] }>("/admin/cloud-status").then((value) => { if (active) setCloudConfigured(value.settings.every((item) => item.configured)); }).catch(() => { if (active) setCloudConfigured(undefined); });
    return () => { active = false; };
  }, [isAdmin]);
  const steps = [
    { label: "创建店铺", detail: "设置实训店铺资料", status: data.stores.length ? "已完成" : "待处理", target: "stores" as const },
    { label: "创建直播间", detail: "填写课堂名称并设为待开播", status: data.rooms.length ? "已完成" : "待处理", target: "rooms" as const },
    { label: "绑定本场商品", detail: "学生才能在课堂看到小黄车", status: data.rooms.some((room) => room.productCount > 0) ? "已完成" : "待处理", target: "rooms" as const },
    ...(isAdmin ? [{ label: "检查直播与回放", detail: cloudConfigured ? "配置已填写，仍需真实开播验证" : "首次开课前完成云接入配置", status: cloudConfigured ? "待实测" : "待配置", target: "cloud" as const }] : [])
  ];
  return <>
    <div className="stat-grid">
      <Card><Statistic title="待开播课堂" value={data.rooms.filter((room) => room.status === "READY").length} /></Card>
      <Card><Statistic title="正在直播" value={data.rooms.filter((room) => room.status === "LIVE").length} /></Card>
      <Card><Statistic title="待交付订单" value={pendingOrders ?? "—"} /></Card>
      <Card><Statistic title="有回放的课堂" value={data.rooms.filter((room) => room.recordingCount > 0).length} /></Card>
    </div>
    <div className="overview-grid">
      <Card title="近期课堂" extra={<Button type="link" onClick={() => navigate("rooms")}>管理课堂 <ArrowRightOutlined /></Button>}>
        {data.rooms.slice(0, 6).map((room) => <div className="overview-room" key={room.id}>
          <div><strong>{room.title}</strong><p className="small muted">{room.store.name} · {room.productCount} 件本场商品 · {room.recordingCount} 条回放</p></div>
          <RoomStatus status={room.status} /><Button size="small" onClick={() => navigate("rooms")}>管理</Button>
        </div>)}
        {!data.rooms.length && <Button type="link" onClick={() => navigate("stores")}>先创建店铺和第一间课堂</Button>}
      </Card>
      <Card title="开课准备">
        {steps.map((step) => <Button type="text" block key={step.label} className="setup-step" onClick={() => navigate(step.target)}>
          <Tag color={step.status === "已完成" ? "green" : "orange"}>{step.status}</Tag>
          <div><b>{step.label}</b><small>{step.detail}</small></div><ArrowRightOutlined />
        </Button>)}
        <Button block className="spaced-top" onClick={() => navigate("orders")}>处理兑换订单{pendingOrders ? `（${pendingOrders}）` : ""}</Button>
      </Card>
    </div>
  </>;
}
