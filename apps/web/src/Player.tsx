import { useEffect, useRef, useState } from "react";
import { Alert, Button } from "antd";
import { PauseCircleOutlined, VideoCameraOutlined } from "@ant-design/icons";
import { io } from "socket.io-client";
import type Hls from "hls.js";
import type mpegts from "mpegts.js";
import { api } from "./api";

type Playback = { status: "DRAFT" | "READY" | "LIVE" | "ENDED"; hls: string; flv: string; expiresAt: string };

export function Player({ roomId, previewMock = false }: { roomId: string; previewMock?: boolean }) {
  const mock = import.meta.env.DEV && (previewMock || new URLSearchParams(location.search).get("mock") === "1");
  const videoRef = useRef<HTMLVideoElement>(null);
  const [error, setError] = useState("");
  const [idleStatus, setIdleStatus] = useState<Playback["status"] | null>(null);
  const [attempt, setAttempt] = useState(0);
  // 画面比例自适应：横屏铺满列宽；竖屏按视频内在尺寸收窄成整块竖屏居中（video.js#7620 社区做法）。
  const [ratio, setRatio] = useState<{ w: number; h: number } | null>(null);

  // 订阅直播状态：正常结束（ENDED 广播）显示持久的“直播已结束”遮罩，与网络中断的
  // “等待画面恢复”有效区分；重新开播（LIVE）清除遮罩并自动重连拉流。
  useEffect(() => {
    if (mock || !roomId) return;
    const connection = io({ transports: ["websocket"] });
    connection.on("connect", () => { connection.timeout(8000).emit("join-room", roomId, () => undefined); });
    connection.on("room-status", (event: { roomId: string; status: "LIVE" | "ENDED" }) => {
      if (event.roomId !== roomId) return;
      setError("");
      setIdleStatus(event.status === "ENDED" ? "ENDED" : null);
      setAttempt((value) => value + 1); // 重跑主 effect：ENDED 停止拉流 / LIVE 重建拉流
    });
    return () => { connection.disconnect(); };
  }, [roomId, mock]);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    let cancelled = false;
    let hlsPlayer: Hls | undefined;
    let flvPlayer: ReturnType<typeof mpegts.createPlayer> | undefined;
    let hlsStarted = false;
    setError("");
    setIdleStatus(null);
    if (mock) return;
    api<Playback>(`/rooms/${roomId}/playback`).then(async ({ hls, flv, status }) => {
      if (cancelled) return;
      // 已结束：不再建立拉流（避免断流错误覆盖“直播已结束”遮罩）；
      // DRAFT/READY 保持拉流等待，开播后画面自动出现。
      if (status === "ENDED") { setIdleStatus("ENDED"); return; }
      if (status !== "LIVE") setIdleStatus(status);
      const startHls = async () => {
        if (cancelled || hlsStarted) return;
        hlsStarted = true;
        if (video.canPlayType("application/vnd.apple.mpegurl")) {
          video.src = hls;
          return;
        }
        const { default: Hls } = await import("hls.js");
        if (cancelled) return;
        if (Hls.isSupported()) {
          hlsPlayer = new Hls({ liveSyncDurationCount: 2 });
          hlsPlayer.on(Hls.Events.ERROR, (_event, data) => {
            if (data.fatal && !cancelled) setError("直播暂时不可用，教师可能尚未开播或网络已中断，请稍后重试。");
          });
          hlsPlayer.loadSource(hls);
          hlsPlayer.attachMedia(video);
        } else {
          setError("当前浏览器不支持直播播放，请使用新版 Chrome 或 Safari。");
        }
      };
      const { default: mpegts } = await import("mpegts.js");
      if (cancelled) return;
      // Chrome/Edge 等现代浏览器一律优先 mpegts.js 播 FLV（低延迟）；
      // 原生 HLS 仅作为不支持 mpegts.js 的浏览器（如部分 Safari）的兜底。
      if (mpegts.isSupported()) {
        flvPlayer = mpegts.createPlayer({ type: "flv", isLive: true, url: flv }, { enableStashBuffer: false });
        flvPlayer.attachMediaElement(video);
        flvPlayer.on(mpegts.Events.ERROR, () => {
          flvPlayer?.destroy();
          flvPlayer = undefined;
          void startHls().catch(() => { if (!cancelled) setError("备用播放器加载失败，请重新连接。"); });
        });
        flvPlayer.load();
        void flvPlayer.play()?.catch(() => { /* 浏览器可要求用户主动点击播放 */ });
      } else if (video.canPlayType("application/vnd.apple.mpegurl")) {
        await startHls();
      } else {
        setError("当前浏览器不支持直播播放，请使用新版 Chrome 或 Safari。");
      }
    }).catch((reason: unknown) => {
      if (!cancelled) setError(reason instanceof Error ? reason.message : "获取播放地址失败");
    });
    return () => {
      cancelled = true;
      flvPlayer?.destroy();
      hlsPlayer?.destroy();
      video.removeAttribute("src");
      video.load();
    };
  }, [roomId, attempt, mock]);

  const portrait = !!ratio && ratio.h > ratio.w;
  return <div className={`player${portrait ? " player--portrait" : ""}`}>
    <video ref={videoRef} controls playsInline webkit-playsinline x5-playsinline x-webkit-airplay="allow" autoPlay muted loop={mock} src={mock ? "/mock/new-year.mp4" : undefined} style={portrait ? { height: "min(74vh, 720px)", width: "auto", maxWidth: "100%", aspectRatio: ratio ? `${ratio.w} / ${ratio.h}` : "9 / 16" } : { aspectRatio: ratio ? `${ratio.w} / ${ratio.h}` : "16 / 9" }} onLoadedMetadata={(event) => { const target = event.currentTarget; if (target.videoWidth && target.videoHeight) setRatio({ w: target.videoWidth, h: target.videoHeight }); }} onError={() => setError(mock ? "本地演示视频未找到，请确认桌面的新年视频mp4.mp4仍在原位置。" : "暂时无法播放，请确认教师已开播后重试。")} onPlaying={() => { setError(""); setIdleStatus(null); }} onStalled={() => { if (!mock && !error && idleStatus !== "ENDED") setError("直播信号中断，正在等待画面恢复…"); }} />
    {idleStatus && !mock && !error && <div className="player__idle" aria-live="polite">
      <span className="player__idle-badge">{idleStatus === "ENDED" ? "已结束" : "未开播"}</span>
      {idleStatus === "ENDED" ? <PauseCircleOutlined className="player__idle-icon" /> : <VideoCameraOutlined className="player__idle-icon" />}
      <b>{idleStatus === "ENDED" ? "直播已结束" : "课堂未开播"}</b>
      <span className="player__idle-sub">{idleStatus === "ENDED" ? "可稍后在课程回放中查看录像" : "开播后画面会自动出现，无需刷新"}</span>
    </div>}
    {mock && <Alert type="info" title="本地视频演示 · 不代表真实直播已接通" showIcon className="spaced-top" />}
    {error && <Alert type="warning" title={error} showIcon action={<Button size="small" onClick={() => setAttempt((value) => value + 1)}>重新连接</Button>} />}
    <span className="player__hint">{mock ? "演示视频会循环播放，点击播放器可取消静音。" : "点击播放器可取消静音。未开播时画面可能暂时为空。"}</span>
  </div>;
}
