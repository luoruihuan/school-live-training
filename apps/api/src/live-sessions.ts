// 把当天的开播 / 关播 / 回放入库审计日志归并成"场"：教师断流重连算同一场，并标出已关播却没有回放的场。
// 只依赖审计日志，不需要新表；按课堂标题匹配（系统写入的文案固定为「课堂「标题」…」）。

export type LiveAuditRow = { action: string; detail: string; createdAt: Date };

export type LiveSession = {
  title: string;
  startedAt: Date;
  /** 最后一段的关播时间；仍在直播时为 null。 */
  endedAt: Date | null;
  /** 实际推流秒数，不含中断间隔。 */
  seconds: number;
  /** 同一场内断流后重新推流的次数。 */
  reconnects: number;
  /** 已入库的回放条数。 */
  recordings: number;
  /** 最近一段关播到回放入库的秒数。 */
  recordingDelaySeconds: number | null;
  /** 有关播段超过宽限期仍没有回放。 */
  recordingMissing: boolean;
};

/** 关播后这么久之内重新推流，视为同一场（断流重连）。 */
export const RECONNECT_GAP_MS = 5 * 60_000;
/** 关播后这么久仍没有回放，视为缺失（腾讯云录制回调通常在关播后数秒到数分钟内到达）。 */
export const RECORDING_GRACE_MS = 10 * 60_000;

/** 北京时间的当天零点（容器时区是 UTC，直接 setHours 会把零点算到早上 8 点）。 */
export function beijingDayStart(now = new Date()): Date {
  const shifted = new Date(now.getTime() + 8 * 3600_000);
  shifted.setUTCHours(0, 0, 0, 0);
  return new Date(shifted.getTime() - 8 * 3600_000);
}

export function groupLiveSessions(rows: LiveAuditRow[], now = new Date()): LiveSession[] {
  const events = new Map<string, { at: Date; kind: "start" | "stop" | "saved" }[]>();
  for (const row of rows) {
    const kind = row.action === "PUBLISH_START" ? "start" : row.action === "PUBLISH_STOP" ? "stop" : row.action === "RECORDING_SAVED" ? "saved" : null;
    if (!kind) continue;
    const match = /课堂「(.+?)」/.exec(row.detail);
    if (!match) continue;
    const list = events.get(match[1]) ?? [];
    list.push({ at: row.createdAt, kind });
    events.set(match[1], list);
  }

  const sessions: LiveSession[] = [];
  for (const [title, list] of events) {
    list.sort((a, b) => a.at.getTime() - b.at.getTime());
    let current: LiveSession | null = null;
    let open: Date | null = null;              // 当前推流段的开播时间
    let lastEnd: Date | null = null;           // 最近一段的关播时间
    let pending = 0;                           // 已关播但还没等到回放的推流段数
    let oldestPendingEnd: Date | null = null;

    for (const event of list) {
      if (event.kind === "start") {
        if (open) {
          // 上一段没等到关播就再次开播：按断流重连处理，上一段在此时结束。
          current!.reconnects++;
          current!.seconds += (event.at.getTime() - open.getTime()) / 1000;
          lastEnd = event.at;
          pending++;
          if (!oldestPendingEnd) oldestPendingEnd = event.at;
          open = event.at;
        } else if (current && lastEnd && event.at.getTime() - lastEnd.getTime() <= RECONNECT_GAP_MS) {
          current.reconnects++;
          open = event.at;
        } else {
          current = { title, startedAt: event.at, endedAt: null, seconds: 0, reconnects: 0, recordings: 0, recordingDelaySeconds: null, recordingMissing: false };
          sessions.push(current);
          lastEnd = null;
          pending = 0;
          oldestPendingEnd = null;
          open = event.at;
        }
      } else if (event.kind === "stop") {
        if (!open || !current) continue;
        current.seconds += (event.at.getTime() - open.getTime()) / 1000;
        lastEnd = event.at;
        pending++;
        if (!oldestPendingEnd) oldestPendingEnd = event.at;
        open = null;
      } else if (current && lastEnd) {
        current.recordings++;
        current.recordingDelaySeconds = Math.max(0, Math.round((event.at.getTime() - lastEnd.getTime()) / 1000));
        pending = Math.max(0, pending - 1);
      }
    }

    if (!current) continue;
    if (open) {
      current.seconds += (now.getTime() - open.getTime()) / 1000;
    } else {
      current.endedAt = lastEnd;
    }
    current.seconds = Math.round(current.seconds);
    current.recordingMissing = !open && pending > 0 && oldestPendingEnd !== null && now.getTime() - oldestPendingEnd.getTime() > RECORDING_GRACE_MS;
  }

  return sessions.sort((a, b) => b.startedAt.getTime() - a.startedAt.getTime());
}
