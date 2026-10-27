import { useEffect, useState } from "react";
import { Alert, Button, Empty, Form, Input, Popconfirm, Tag } from "antd";
import { io, type Socket } from "socket.io-client";
import { api } from "./api";

type Message = {
  id: string;
  roomId: string;
  content: string;
  createdAt: string;
  user: { id: string; displayName: string; role: string };
};

export function Chat({ roomId, canModerate }: { roomId: string; canModerate: boolean }) {
  const [messages, setMessages] = useState<Message[]>([]);
  const [draft, setDraft] = useState("");
  const [error, setError] = useState("");
  const [socket, setSocket] = useState<Socket | null>(null);
  const [connected, setConnected] = useState(false);
  const [sending, setSending] = useState(false);

  useEffect(() => {
    let active = true;
    setMessages([]);
    setError("");
    setConnected(false);
    api<Message[]>(`/rooms/${roomId}/messages`).then((items) => {
      if (active) setMessages((current) => [...new Map([...items, ...current].map((m) => [m.id, m])).values()].sort((a, b) => a.createdAt.localeCompare(b.createdAt)).slice(-50));
    }).catch((reason: unknown) => {
      if (active) setError(reason instanceof Error ? reason.message : "读取互动消息失败");
    });
    const connection = io({ transports: ["websocket"] });
    connection.on("connect", () => connection.timeout(8000).emit("join-room", roomId, (timeout: Error | null, response?: { ok: boolean; message?: string }) => {
      if (!active) return;
      setConnected(!timeout && !!response?.ok);
      setError(timeout ? "课堂连接超时，请重新进入课堂" : response?.ok ? "" : response?.message ?? "进入课堂失败");
    }));
    connection.on("disconnect", (reason) => { if (active) { setConnected(false); setError(reason === "io server disconnect" ? "登录会话已失效，请重新登录；如账号已停用，请联系管理员。" : "互动连接已断开，正在尝试恢复。"); } });
    connection.on("new-message", (message: Message) => {
      if (active && message.roomId === roomId) {
        setMessages((items) => [...items.filter((item) => item.id !== message.id), message].slice(-50));
      }
    });
    connection.on("remove-message", (event: { roomId: string; messageId: string }) => {
      if (active && event.roomId === roomId) setMessages((items) => items.filter((item) => item.id !== event.messageId));
    });
    connection.on("connect_error", () => { if (active) setError("互动连接失败，请稍后重试"); });
    setSocket(connection);
    return () => { active = false; connection.disconnect(); setSocket(null); };
  }, [roomId]);

  function send(): void {
    if (!socket || !draft.trim() || !connected || sending) return;
    setSending(true);
    socket.timeout(8000).emit("send-message", { roomId, content: draft.trim() }, (timeout: Error | null, response?: { ok: boolean; message?: string }) => {
      setSending(false);
      if (timeout || !response) { setError("发送结果未知，请先检查消息记录，避免重复发送。"); return; }
      if (response.ok) { setDraft(""); setError(""); }
      else setError(response.message ?? "发送失败");
    });
  }

  async function moderate(message: Message, action: "hide" | "mute"): Promise<void> {
    setError("");
    try {
      if (action === "hide") {
        await api(`/rooms/${roomId}/messages/${message.id}`, { method: "DELETE" });
        setMessages((items) => items.filter((item) => item.id !== message.id));
      } else {
        await api(`/rooms/${roomId}/mutes`, { method: "POST", body: JSON.stringify({ userId: message.user.id }) });
      }
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "管理操作失败");
    }
  }

  return <section className="chat"><div className="section-heading"><h3>课堂互动</h3><Tag color={connected ? "green" : "default"}>{connected ? "已连接" : "连接中"}</Tag></div>
    <div className="chat__messages" aria-live="polite">
      {messages.length === 0 && <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="还没有消息，来发起第一条互动吧" />}
      {messages.map((message) => <div className="chat__message" key={message.id}><div className="chat__author"><strong>{message.user.displayName}</strong><small>{new Date(message.createdAt).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" })}</small></div><span>{message.content}</span>{canModerate && <span className="chat__actions"><Popconfirm title="隐藏此条消息？" onConfirm={() => moderate(message, "hide")}><Button size="small" type="text" danger>删除</Button></Popconfirm>{message.user.role === "STUDENT" && <Popconfirm title="将该学生在本课堂禁言 1 小时？" onConfirm={() => moderate(message, "mute")}><Button size="small" type="text">禁言</Button></Popconfirm>}</span>}</div>)}
    </div>
    <Form onFinish={send} className="chat__form"><Input value={draft} onChange={(event) => setDraft(event.target.value)} maxLength={500} placeholder="分享你的想法…" aria-label="互动内容" /><Button type="primary" htmlType="submit" disabled={!draft.trim() || !connected} loading={sending}>发送</Button></Form>
    {error && <Alert type="warning" title={error} showIcon className="spaced-top" />}
  </section>;
}
