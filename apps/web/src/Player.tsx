import { useEffect, useRef, useState, type CSSProperties } from "react";
import { Alert, Button } from "antd";
import { PauseCircleOutlined, VideoCameraOutlined } from "@ant-design/icons";
import { io } from "socket.io-client";
import type Hls from "hls.js";
import type mpegts from "mpegts.js";
import { api } from "./api";

type PlaybackStatus = "DRAFT" | "READY" | "LIVE" | "ENDED";
type Playback = { status: PlaybackStatus; hls: string; flv: string; expiresAt: string; refreshInSeconds?: number };
type PlayerState = "INITIALIZING" | "WAITING" | "READY" | "PLAYING" | "BUFFERING" | "RECONNECTING" | "ERROR" | "STOPPED";
type RoomStatusEvent = { roomId: string; status: PlaybackStatus };
type JoinAck = { ok: boolean; status?: PlaybackStatus; message?: string };

const MAX_NETWORK_RECOVERIES = 5;
const MAX_MEDIA_RECOVERIES = 1;
const STALL_NOTICE_MS = 6000;
const MEDIA_ERROR_NOTICE_MS = 4000;

function streamIdFromUrl(url: string): string | undefined {
  try {
    const path = new URL(url, window.location.href).pathname;
    const name = path.split("/").pop() ?? "";
    return name.replace(/\.(m3u8|flv)$/i, "") || undefined;
  } catch {
    return undefined;
  }
}

function redactIdentifier(value: string | undefined): string | undefined {
  if (!value) return undefined;
  let hash = 2166136261;
  for (const character of value) hash = Math.imul(hash ^ character.charCodeAt(0), 16777619);
  return `u-${(hash >>> 0).toString(16)}`;
}

export function Player({ roomId, userId, previewMock = false }: { roomId: string; userId?: string; previewMock?: boolean }) {
  const mock = import.meta.env.DEV && (previewMock || new URLSearchParams(location.search).get("mock") === "1");
  const videoRef = useRef<HTMLVideoElement>(null);
  const mediaInstanceId = useRef("");
  const instanceSequence = useRef(0);
  const roomStatusRef = useRef<PlaybackStatus | null>(null);
  const cleanupReason = useRef("effect_cleanup");
  const mediaActive = useRef(false);
  const nativeHlsUrl = useRef<string | undefined>(undefined);
  const nativeRetryTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const nativeRetryCount = useRef(0);
  const stallTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const [error, setError] = useState("");
  const [idleStatus, setIdleStatus] = useState<PlaybackStatus | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [ratio, setRatio] = useState<{ w: number; h: number } | null>(null);
  const [playerState, setPlayerState] = useState<PlayerState>("INITIALIZING");
  const playerStateRef = useRef<PlayerState>("INITIALIZING");

  function diagnostic(event: string, details: Record<string, unknown> = {}): void {
    const video = videoRef.current;
    const bufferedEnd = video && video.buffered.length > 0 ? video.buffered.end(video.buffered.length - 1) : undefined;
    console.info("[live-player]", {
      event,
      roomId,
      userId: redactIdentifier(userId),
      playerInstanceId: mediaInstanceId.current || undefined,
      state: playerStateRef.current,
      readyState: video?.readyState,
      networkState: video?.networkState,
      currentTime: video?.currentTime,
      bufferedSeconds: bufferedEnd === undefined || video === null ? undefined : Math.max(0, bufferedEnd - video.currentTime),
      orientation: window.matchMedia("(orientation: portrait)").matches ? "portrait" : "landscape",
      viewport: `${window.innerWidth}x${window.innerHeight}`,
      ...details
    });
  }

  function transition(next: PlayerState, reason: string): void {
    const previous = playerStateRef.current;
    playerStateRef.current = next;
    setPlayerState(next);
    diagnostic("state", { from: previous, to: next, reason });
  }

  function updateRoomStatus(next: PlaybackStatus): void {
    const previous = roomStatusRef.current;
    roomStatusRef.current = next;
    setIdleStatus(next === "LIVE" ? null : next);
    if (next === "LIVE") setError("");
    if (previous !== next && (previous === "LIVE" || next === "LIVE")) {
      diagnostic("room_status", { previous, next });
      cleanupReason.current = next === "ENDED" ? "room_ended" : "room_status_changed";
      setAttempt((value) => value + 1);
    }
  }

  useEffect(() => {
    if (mock || !roomId) return;
    const connection = io({ transports: ["websocket"] });
    const joinRoom = () => {
      connection.timeout(8000).emit("join-room", roomId, (timeout: Error | null, response?: JoinAck) => {
        if (timeout) {
          diagnostic("socket_join_timeout");
          return;
        }
        if (!response?.ok || !response.status) {
          diagnostic("socket_join_failed", { message: response?.message });
          return;
        }
        diagnostic("socket_joined", { status: response.status });
        updateRoomStatus(response.status);
      });
    };
    connection.on("connect", joinRoom);
    connection.on("room-status", (event: RoomStatusEvent) => {
      if (event.roomId === roomId) updateRoomStatus(event.status);
    });
    connection.on("disconnect", (reason) => diagnostic("socket_disconnected", { reason }));
    connection.on("connect_error", (reason) => diagnostic("socket_connect_error", { reason: reason.message }));
    return () => {
      connection.disconnect();
      diagnostic("socket_disposed");
    };
  }, [roomId, mock]);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    let cancelled = false;
    let hlsPlayer: Hls | undefined;
    let flvPlayer: ReturnType<typeof mpegts.createPlayer> | undefined;
    let recoveryTimer: ReturnType<typeof setTimeout> | undefined;
    let expiryTimer: ReturnType<typeof setTimeout> | undefined;
    let mediaErrorRecoveries = 0;
    let networkRecoveries = 0;
    let manifestParsed = false;
    let activeStreamId: string | undefined;

    mediaInstanceId.current = `player-${roomId}-${++instanceSequence.current}`;
    cleanupReason.current = "effect_cleanup";
    mediaActive.current = true;
    setError("");
    setIdleStatus(null);
    transition("INITIALIZING", "effect_start");
    diagnostic("player_initialized", { attempt });
    if (mock) return;

    const clearRecoveryTimer = () => {
      if (recoveryTimer) {
        clearTimeout(recoveryTimer);
        recoveryTimer = undefined;
      }
    };

    const clearStallTimer = () => {
      if (stallTimer.current) {
        clearTimeout(stallTimer.current);
        stallTimer.current = undefined;
      }
    };

    const fail = (message: string, reason: string) => {
      if (cancelled) return;
      clearRecoveryTimer();
      transition("ERROR", reason);
      setError(message);
      diagnostic("player_error", { reason, message, streamId: activeStreamId });
    };

    const tryPlay = () => {
      if (cancelled) return;
      const result = video.play();
      if (result) {
        void result.catch((reason: unknown) => {
          diagnostic("play_rejected", { reason: reason instanceof Error ? reason.name : String(reason) });
        });
      }
    };

    const scheduleRecovery = (kind: "network" | "media", action: () => void) => {
      if (cancelled || recoveryTimer) return;
      const count = kind === "network" ? ++networkRecoveries : ++mediaErrorRecoveries;
      const limit = kind === "network" ? MAX_NETWORK_RECOVERIES : MAX_MEDIA_RECOVERIES;
      if (count > limit) {
        fail("直播暂时不可用，自动恢复次数已用尽，请点击重新连接。", `${kind}_recovery_exhausted`);
        return;
      }
      transition("RECONNECTING", `${kind}_recovery_${count}`);
      diagnostic("recovery_scheduled", { kind, count, streamId: activeStreamId });
      recoveryTimer = setTimeout(() => {
        recoveryTimer = undefined;
        if (!cancelled) action();
      }, Math.min(1000 * count, 4000));
    };

    const startHls = async (hlsUrl: string) => {
      if (cancelled) return;
      activeStreamId = streamIdFromUrl(hlsUrl);
      if (video.canPlayType("application/vnd.apple.mpegurl")) {
        activeStreamId = streamIdFromUrl(hlsUrl);
        nativeHlsUrl.current = hlsUrl;
        nativeRetryCount.current = 0;
        diagnostic("adapter_selected", { adapter: "native-hls", streamId: activeStreamId });
        transition("READY", "native_hls_attached");
        video.src = hlsUrl;
        video.load();
        tryPlay();
        return;
      }

      const { default: Hls } = await import("hls.js");
      if (cancelled) return;
      if (!Hls.isSupported()) return;

      diagnostic("adapter_selected", { adapter: "hls.js", streamId: activeStreamId });
      hlsPlayer = new Hls({ liveSyncDurationCount: 2, enableWorker: true });
      hlsPlayer.on(Hls.Events.MANIFEST_PARSED, (_event, data) => {
        if (cancelled) return;
        manifestParsed = true;
        networkRecoveries = 0;
        transition("READY", "manifest_parsed");
        diagnostic("manifest_parsed", { levels: data.levels?.length ?? 0, streamId: activeStreamId });
        tryPlay();
      });
      hlsPlayer.on(Hls.Events.FRAG_BUFFERED, () => {
        if (cancelled) return;
        clearTimeoutIfNeeded(stallTimer);
        if (playerStateRef.current === "BUFFERING") transition("READY", "fragment_buffered");
      });
      hlsPlayer.on(Hls.Events.ERROR, (_event, data) => {
        if (cancelled) return;
        diagnostic("hls_error", {
          type: data.type,
          details: data.details,
          fatal: data.fatal,
          responseCode: data.response?.code,
          streamId: activeStreamId
        });
        if (!data.fatal) return;
        if (data.type === Hls.ErrorTypes.MEDIA_ERROR) {
          scheduleRecovery("media", () => hlsPlayer?.recoverMediaError());
          return;
        }
        if (data.type === Hls.ErrorTypes.NETWORK_ERROR) {
          scheduleRecovery("network", () => {
            if (!hlsPlayer) return;
            if (manifestParsed) hlsPlayer.startLoad();
            else hlsPlayer.loadSource(hlsUrl);
          });
          return;
        }
        fail("当前浏览器无法解码直播内容，请点击重新连接。", "fatal_hls_error");
      });
      hlsPlayer.loadSource(hlsUrl);
      hlsPlayer.attachMedia(video);
    };

    api<Playback>(`/rooms/${roomId}/playback`).then(async ({ hls, flv, status, refreshInSeconds }) => {
      if (cancelled) return;
      diagnostic("playback_address", { status, streamId: streamIdFromUrl(hls) });
      if (status === "LIVE" && roomStatusRef.current === "ENDED") {
        transition("WAITING", "socket_ended_wins");
        return;
      }
      if (status === "ENDED" && roomStatusRef.current !== "LIVE") {
        roomStatusRef.current = status;
        setIdleStatus(status);
        transition("WAITING", "stream_ended");
        return;
      }
      if (status !== "LIVE" && roomStatusRef.current !== "LIVE") {
        roomStatusRef.current = status;
        setIdleStatus(status);
        transition("WAITING", "stream_not_live");
        return;
      }
      if (!hls) {
        roomStatusRef.current = status;
        setIdleStatus(status);
        transition("WAITING", "stream_address_pending");
        return;
      }
      roomStatusRef.current = "LIVE";
      setIdleStatus(null);
      if (refreshInSeconds && Number.isFinite(refreshInSeconds) && refreshInSeconds > 0) {
        expiryTimer = setTimeout(() => {
          if (cancelled || roomStatusRef.current !== "LIVE") return;
          cleanupReason.current = "playback_signature_refresh";
          setAttempt((n) => n + 1);
        }, refreshInSeconds * 1000);
      }
      await startHls(hls);
      if (hlsPlayer || video.canPlayType("application/vnd.apple.mpegurl")) return;

      const { default: mpegts } = await import("mpegts.js");
      if (cancelled) return;
      if (!mpegts.isSupported()) {
        fail("当前浏览器不支持直播播放，请使用新版 Chrome 或 Safari。", "unsupported_browser");
        return;
      }
      activeStreamId = streamIdFromUrl(flv);
      diagnostic("adapter_selected", { adapter: "mpegts-flv", streamId: activeStreamId });
      flvPlayer = mpegts.createPlayer({ type: "flv", isLive: true, url: flv }, { enableStashBuffer: false });
      flvPlayer.on(mpegts.Events.ERROR, (errorType, errorDetail) => {
        fail("直播连接已中断，请点击重新连接。", "flv_error");
        diagnostic("flv_error", { errorType, errorDetail, streamId: activeStreamId });
      });
      flvPlayer.attachMediaElement(video);
      flvPlayer.load();
      transition("READY", "flv_attached");
      tryPlay();
    }).catch((reason: unknown) => {
      if (!cancelled) fail(reason instanceof Error ? reason.message : "获取播放地址失败", "playback_address_error");
    });

    return () => {
      cancelled = true;
      mediaActive.current = false;
      clearTimeout(expiryTimer);
      clearRecoveryTimer();
      clearStallTimer();
      if (nativeRetryTimer.current) {
        clearTimeout(nativeRetryTimer.current);
        nativeRetryTimer.current = undefined;
      }
      nativeHlsUrl.current = undefined;
      diagnostic("player_disposed", { reason: cleanupReason.current, streamId: activeStreamId });
      flvPlayer?.destroy();
      hlsPlayer?.destroy();
      video.pause();
      video.removeAttribute("src");
    };
  }, [roomId, attempt, mock]);

  const portrait = !!ratio && ratio.h > ratio.w;
  const playerStyle: CSSProperties = ratio ? { aspectRatio: `${ratio.w} / ${ratio.h}` } : { aspectRatio: "16 / 9" };

  return <div className={`player${portrait ? " player--portrait" : ""}`} style={playerStyle} data-player-state={playerState}>
    <video
      ref={videoRef}
      controls
      playsInline
      webkit-playsinline
      x5-playsinline
      x-webkit-airplay="allow"
      autoPlay
      muted
      loop={mock}
      src={mock ? "/mock/new-year.mp4" : undefined}
      onLoadedMetadata={(event) => {
        const target = event.currentTarget;
        if (target.videoWidth && target.videoHeight) {
          setRatio({ w: target.videoWidth, h: target.videoHeight });
          diagnostic("metadata", { width: target.videoWidth, height: target.videoHeight });
        }
      }}
      onError={() => {
        if (mock) {
          setError("本地演示视频未找到，请确认桌面的新年视频mp4.mp4仍在原位置。");
          return;
        }
        if (!mediaActive.current) return;
        if (error || idleStatus === "ENDED") return;
        if (nativeHlsUrl.current && nativeRetryCount.current < MAX_NETWORK_RECOVERIES) {
          const count = ++nativeRetryCount.current;
          if (!nativeRetryTimer.current) {
            diagnostic("native_hls_retry_scheduled", { count });
            nativeRetryTimer.current = setTimeout(() => {
              nativeRetryTimer.current = undefined;
              const url = nativeHlsUrl.current;
              if (!url) return;
              diagnostic("native_hls_retry", { count });
              const video = videoRef.current;
              if (!video) return;
              video.src = url;
              video.load();
              const result = video.play();
              if (result) void result.catch(() => undefined);
            }, Math.min(1000 * count, 4000));
          }
          return;
        }
        if (stallTimer.current) clearTimeout(stallTimer.current);
        stallTimer.current = setTimeout(() => {
          setError("暂时无法播放，请确认教师已开播后重试。");
          playerStateRef.current = "ERROR";
          setPlayerState("ERROR");
          diagnostic("player_error", { reason: "video_error_timeout" });
        }, MEDIA_ERROR_NOTICE_MS);
      }}
      onPlaying={() => {
        nativeRetryCount.current = 0;
        clearTimeoutIfNeeded(stallTimer);
        playerStateRef.current = "PLAYING";
        setPlayerState("PLAYING");
        setError("");
        setIdleStatus(null);
        diagnostic("playing");
      }}
      onWaiting={() => {
        if (mock || !mediaActive.current || idleStatus === "ENDED") return;
        playerStateRef.current = "BUFFERING";
        setPlayerState("BUFFERING");
        diagnostic("waiting");
        if (stallTimer.current) clearTimeout(stallTimer.current);
        stallTimer.current = setTimeout(() => {
          if (!mediaActive.current) return;
          setError("直播信号中断，正在等待画面恢复…");
          diagnostic("buffering_notice");
        }, STALL_NOTICE_MS);
      }}
      onTimeUpdate={() => clearTimeoutIfNeeded(stallTimer)}
    />
    {idleStatus && !mock && !error && <div className="player__idle" aria-live="polite">
      <span className="player__idle-badge">{idleStatus === "ENDED" ? "已结束" : "未开播"}</span>
      {idleStatus === "ENDED" ? <PauseCircleOutlined className="player__idle-icon" /> : <VideoCameraOutlined className="player__idle-icon" />}
      <b>{idleStatus === "ENDED" ? "直播已结束" : "课堂未开播"}</b>
      <span className="player__idle-sub">{idleStatus === "ENDED" ? "可稍后在课程回放中查看录像" : "开播后画面会自动出现，无需刷新"}</span>
    </div>}
    {mock && <Alert type="info" title="本地视频演示 · 不代表真实直播已接通" showIcon className="spaced-top" />}
    {error && <Alert type="warning" title={error} showIcon action={<Button size="small" onClick={() => { diagnostic("manual_retry"); cleanupReason.current = "manual_retry"; setError(""); setAttempt((value) => value + 1); }}>重新连接</Button>} />}
    <span className="player__hint">{mock ? "演示视频会循环播放，点击播放器可取消静音。" : "点击播放器可取消静音。未开播时画面可能暂时为空。"}</span>
  </div>;
}

function clearTimeoutIfNeeded(timer: { current: ReturnType<typeof setTimeout> | undefined }): void {
  if (timer.current) {
    clearTimeout(timer.current);
    timer.current = undefined;
  }
}
