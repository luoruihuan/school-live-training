import { Empty, Tag } from "antd";
import { ShoppingOutlined } from "@ant-design/icons";
import type { Product, Room } from "./api";

export const roomStatus = { DRAFT: "准备中", READY: "待开播", LIVE: "直播中", ENDED: "已结束" };
export function RoomStatus({ status }: { status: Room["status"] }) {
  return <Tag color={status === "LIVE" ? "green" : status === "READY" ? "blue" : "default"}>{roomStatus[status]}</Tag>;
}
export function ProductImage({ product }: { product: Product }) {
  return <div className="product-image">{product.imageUrl ? <img src={product.imageUrl} alt={product.name} loading="lazy" /> : <ShoppingOutlined />}</div>;
}
export function NoData({ text }: { text: string }) { return <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={text} />; }
export function PageTitle({ label, title, description }: { label: string; title: string; description: string }) {
  return <div className="page-title"><span className="eyebrow">{label}</span><h1>{title}</h1><p>{description}</p></div>;
}
