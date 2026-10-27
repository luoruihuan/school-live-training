import { useEffect, useRef, useState } from "react";
import { Alert, Button } from "antd";
import type Hls from "hls.js";
import type mpegts from "mpegts.js";
import { api } from "./api";

type Playback = { hls: string; flv: string; expiresAt: string };

export function Player({ roomId, previewMock = false }: { roomId: string; previewMock?: boolean }) {
  const mock = import.meta.env.DEV && (previewMock || new URLSearchParams(location.search).get("mock") === "1");
  const videoRef = useRef<HTMLVideoElement>(null);
  const [error, setError] = useState("");
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    let cancelled = false;
    let hlsPlayer: Hls | undefined;
    let flvPlayer: ReturnType<typeof mpegts.createPlayer> | undefined;
    let hlsStarted = false;
    setError("");
    if (mock) return;
    api<Playback>(`/rooms/${roomId}/playback`).then(async ({ hls, flv }) => {
      if (cancelled) return;
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
          hlsPlayer = new Hls({ liveSyncDurationCount: 3 });
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

  return <div className="player">
    <video ref={videoRef} controls playsInline webkit-playsinline x5-playsinline x-webkit-airplay="allow" autoPlay muted loop={mock} src={mock ? "/mock/new-year.mp4" : undefined} onError={() => setError(mock ? "本地演示视频未找到，请确认桌面的新年视频mp4.mp4仍在原位置。" : "暂时无法播放，请确认教师已开播后重试。")} onPlaying={() => setError("")} />
    {mock && <Alert type="info" title="本地视频演示 · 不代表真实直播已接通" showIcon className="spaced-top" />}
    {error && <Alert type="warning" title={error} showIcon action={<Button size="small" onClick={() => setAttempt((value) => value + 1)}>重新连接</Button>} />}
    <span className="player__hint">{mock ? "演示视频会循环播放，点击播放器可取消静音。" : "点击播放器可取消静音。未开播时画面可能暂时为空。"}</span>
  </div>;
}
