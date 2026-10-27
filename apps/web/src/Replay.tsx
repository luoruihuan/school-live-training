import { useEffect, useRef, useState } from "react";
import { Alert, Button, Empty, Space, Spin, Tag } from "antd";
import { api } from "./api";

type Recording = { id: string; durationSecs: number | null; createdAt: string; expiresAt: string };

export function Replay({ roomId }: { roomId: string }) {
  const [items, setItems] = useState<Recording[]>([]);
  const [url, setUrl] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [playingId, setPlayingId] = useState("");
  const [revision, setRevision] = useState(0);
  const playRequest = useRef(0);

  useEffect(() => {
    let active = true;
    setItems([]);
    setUrl("");
    setError("");
    setLoading(true);
    api<Recording[]>(`/rooms/${roomId}/recordings`).then((recordings) => {
      if (active) setItems(recordings);
    }).catch((reason: unknown) => {
      if (active) setError(reason instanceof Error ? reason.message : "读取回放失败");
    }).finally(() => { if (active) setLoading(false); });
    return () => { active = false; playRequest.current++; };
  }, [roomId, revision]);

  async function play(id: string): Promise<void> {
    const current = ++playRequest.current;
    setPlayingId(id);
    setError("");
    setUrl("");
    try {
      const result = await api<{ url: string }>(`/recordings/${id}/playback`);
      if (current !== playRequest.current) return;
      setUrl(result.url);
    } catch (reason) {
      if (current === playRequest.current) setError(reason instanceof Error ? reason.message : "回放暂不可用");
    } finally { if (current === playRequest.current) setPlayingId(""); }
  }

  return <section className="replay"><div className="section-heading"><Space><h3>直播回放</h3><Tag>{items.length} 条</Tag></Space><Button size="small" loading={loading} onClick={() => setRevision((n) => n + 1)}>刷新回放</Button></div>
    {loading ? <Spin /> : items.length === 0 && <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="暂无回放，录制完成后会自动出现" />}
    {items.map((item) => <div className="replay__row" key={item.id}><div><strong>{new Date(item.createdAt).toLocaleString("zh-CN")}</strong><small>{item.durationSecs ? `时长约 ${Math.ceil(item.durationSecs / 60)} 分钟` : "录制文件"} · {`有效至 ${new Date(item.expiresAt).toLocaleDateString("zh-CN")}`}</small></div><Button loading={playingId === item.id} onClick={() => void play(item.id)}>播放回放</Button></div>)}
    {error && <Alert type="error" title={error} showIcon className="spaced-top" />}
    {url && <video className="replay__video" controls playsInline src={url} onError={() => setError("回放加载失败，地址可能已过期，请重新点击播放回放。")} />}
  </section>;
}
