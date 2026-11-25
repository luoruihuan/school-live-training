import { useEffect, useRef, type CSSProperties } from "react";

/** 一条在屏弹幕。轨道与入场延迟由 Player 在入队时计算并固定。 */
export type DanmakuItem = {
  id: string;
  author: string;
  role: string;
  content: string;
  track: number;
  /** 入场延迟毫秒数(同轨道排队时大于 0) */
  delay: number;
};

/** 直播间新消息事件负载(chat.gateway 广播的 new-message) */
export type DanmakuMessage = {
  id: string;
  roomId: string;
  content: string;
  createdAt: string;
  user: { id: string; displayName: string; role: string };
};

/** 每条弹幕占用的行高,需与 theme.less 中 .player__danmaku-item 的占位保持一致 */
export const DANMAKU_LINE_HEIGHT = 30;
/** 弹幕从右到左的滚动时长(秒),与 theme.less 的 --danmaku-duration 保持一致 */
export const DANMAKU_DURATION_SECONDS = 9;

/**
 * 弹幕展示层:纯受控渲染,每条弹幕一个元素,CSS 动画驱动滚动(合成器线程执行,
 * 不与视频解码、hls.js 缓冲管理竞争主线程),动画结束后回调父组件移除。
 * 容器宽度通过 CSS 变量注入,供 keyframes 计算位移距离;层本身不接收任何指针事件。
 */
export function DanmakuLayer({ items, onExpired }: { items: DanmakuItem[]; onExpired: (id: string) => void }) {
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const element = containerRef.current;
    if (!element) return;
    const update = () => element.style.setProperty("--danmaku-travel", `${Math.ceil(element.clientWidth)}px`);
    update();
    const observer = new ResizeObserver(update);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  return <div className="player__danmaku" ref={containerRef} aria-hidden="true">
    {items.map((item) => (
      <span
        key={item.id}
        className={item.role === "STUDENT" ? "player__danmaku-item" : "player__danmaku-item player__danmaku-item--staff"}
        style={{ top: `${item.track * DANMAKU_LINE_HEIGHT + 6}px`, animationDelay: `${item.delay}ms` } as CSSProperties}
        onAnimationEnd={() => onExpired(item.id)}
      >
        <b>{item.author}</b>{item.content}
      </span>
    ))}
  </div>;
}
