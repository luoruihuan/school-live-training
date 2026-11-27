import assert from "node:assert/strict";
import test from "node:test";
import { beijingDayStart, groupLiveSessions } from "./live-sessions.js";

const T0 = new Date("2026-11-27T10:00:00Z").getTime();
const at = (seconds: number) => new Date(T0 + seconds * 1000);
const start = (title: string, seconds: number) => ({ action: "PUBLISH_START", detail: `课堂「${title}」开始直播`, createdAt: at(seconds) });
const stop = (title: string, seconds: number) => ({ action: "PUBLISH_STOP", detail: `课堂「${title}」结束直播`, createdAt: at(seconds) });
const saved = (title: string, seconds: number) => ({ action: "RECORDING_SAVED", detail: `课堂「${title}」新增回放`, createdAt: at(seconds) });

test("一场正常直播：时长、回放入库延迟", () => {
  const [session] = groupLiveSessions([start("试用", 0), stop("试用", 321), saved("试用", 324)], at(400));
  assert.equal(session.title, "试用");
  assert.equal(session.seconds, 321);
  assert.equal(session.reconnects, 0);
  assert.equal(session.recordings, 1);
  assert.equal(session.recordingDelaySeconds, 3);
  assert.equal(session.recordingMissing, false);
  assert.deepEqual(session.endedAt, at(321));
});

test("关播后 5 分钟内重新推流算同一场，记一次中断重连；间隔更久则是两场", () => {
  const rows = [start("试用", 0), stop("试用", 120), start("试用", 150), stop("试用", 360), saved("试用", 140), saved("试用", 365)];
  const sessions = groupLiveSessions(rows, at(500));
  assert.equal(sessions.length, 1);
  assert.equal(sessions[0].reconnects, 1);
  assert.equal(sessions[0].seconds, 120 + 210);
  assert.equal(sessions[0].recordings, 2);
  assert.equal(sessions[0].recordingDelaySeconds, 5);

  const apart = groupLiveSessions([start("试用", 0), stop("试用", 120), start("试用", 120 + 301), stop("试用", 600)], at(700));
  assert.equal(apart.length, 2);
  assert.equal(apart[0].reconnects, 0);
  assert.equal(apart[1].reconnects, 0);
});

test("没等到关播就再次开播，按断流重连处理", () => {
  const [session] = groupLiveSessions([start("试用", 0), start("试用", 90), stop("试用", 200), saved("试用", 203)], at(300));
  assert.equal(session.reconnects, 1);
  assert.equal(session.seconds, 200);
  assert.equal(session.recordings, 1);
  assert.equal(session.recordingMissing, false);
});

test("关播超过 10 分钟仍无回放记为缺失；宽限期内不报", () => {
  const rows = [start("试用", 0), stop("试用", 300)];
  const early = groupLiveSessions(rows, at(300 + 5 * 60));
  assert.equal(early[0].recordingMissing, false);
  const late = groupLiveSessions(rows, at(300 + 11 * 60));
  assert.equal(late[0].recordingMissing, true);
});

test("正在直播的场：没有关播时间，时长按当前时刻累加", () => {
  const [session] = groupLiveSessions([start("试用", 0)], at(180));
  assert.equal(session.endedAt, null);
  assert.equal(session.seconds, 180);
  assert.equal(session.recordingMissing, false);
});

test("多个课堂互不影响；无关动作被忽略", () => {
  const rows = [start("甲", 0), { action: "LOGIN", detail: "课堂「乙」登录成功", createdAt: at(1) }, stop("甲", 60), start("乙", 30), stop("乙", 90)];
  const sessions = groupLiveSessions(rows, at(200));
  assert.deepEqual(sessions.map((session) => session.title), ["乙", "甲"]);
  assert.equal(sessions[0].seconds, 60);
});

test("当天零点按北京时间计算", () => {
  assert.deepEqual(beijingDayStart(new Date("2026-11-27T17:59:00Z")), new Date("2026-11-27T16:00:00Z"));
  assert.deepEqual(beijingDayStart(new Date("2026-11-27T15:59:00Z")), new Date("2026-11-26T16:00:00Z"));
});
