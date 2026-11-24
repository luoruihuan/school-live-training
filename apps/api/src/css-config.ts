import { createHash, timingSafeEqual } from "node:crypto";
import { BadRequestException, ForbiddenException, ServiceUnavailableException } from "@nestjs/common";

export const CSS_APP = "live";
export const CSS_PLAY_TTL_SECONDS = 4 * 60 * 60;
const PUSH_TTL_SECONDS = 12 * 60 * 60;

function required(name: string, pattern: RegExp): string {
  const value = process.env[name]?.trim();
  if (!value || !pattern.test(value)) throw new ServiceUnavailableException(`请检查 ${name} 配置`);
  return value;
}

function cssDomain(name: string): string {
  return required(name, /^[a-z0-9-]+(?:\.[a-z0-9-]+)+$/i).toLowerCase();
}

const KEY = /^[a-zA-Z0-9]{16,256}$/;

export function cssConfig() {
  const pushDomain = cssDomain("CSS_PUSH_DOMAIN");
  const playDomain = cssDomain("CSS_PLAY_DOMAIN");
  if (pushDomain === playDomain) throw new ServiceUnavailableException("CSS 推流和播放域名须不同");
  const protocol = process.env.CSS_PUSH_PROTOCOL?.trim() || "rtmp";
  if (protocol !== "rtmp" && protocol !== "rtmps") throw new ServiceUnavailableException("CSS_PUSH_PROTOCOL 须为 rtmp 或 rtmps");
  return {
    pushDomain, playDomain, protocol,
    pushKey: required("CSS_PUSH_KEY", KEY),
    playKey: required("CSS_PLAY_KEY", KEY),
    callbackKey: required("CSS_CALLBACK_KEY", /^[a-zA-Z0-9]{16,32}$/),
    appId: Number(required("CSS_APP_ID", /^[1-9]\d{0,11}$/)),
    bucket: required("COS_RECORDINGS_BUCKET", /^[a-z0-9-]+-\d+$/),
    region: process.env.COS_REGION?.trim() || "ap-shanghai"
  };
}

export function cssSetupError(): string | null {
  try {
    cssConfig();
    for (const key of ["COS_ENDPOINT", "COS_SECRET_ID", "COS_SECRET_KEY"]) required(key, /^\S+$/);
    return null;
  } catch (error) {
    return error instanceof Error ? error.message : "CSS 配置不可用";
  }
}

function sign(key: string, stream: string, timestamp: number): string {
  const txTime = timestamp.toString(16).toUpperCase();
  const txSecret = createHash("md5").update(key + stream + txTime).digest("hex");
  return `txSecret=${txSecret}&txTime=${txTime}`;
}

export function cssPublishAddress(stream: string, now = Math.floor(Date.now() / 1000)) {
  const config = cssConfig();
  const expires = now + PUSH_TTL_SECONDS;
  return {
    url: `${config.protocol}://${config.pushDomain}/${CSS_APP}/${stream}?${sign(config.pushKey, stream, expires)}`,
    expiresAt: new Date(expires * 1000).toISOString()
  };
}

export function cssPlaybackAddress(stream: string, now = Math.floor(Date.now() / 1000)) {
  const { playDomain, playKey } = cssConfig();
  const path = `https://${playDomain}/${CSS_APP}/${stream}`;
  // CSS 播放实际有效期为 txTime + 播放域名设置的有效时间。
  const query = sign(playKey, stream, now);
  return {
    hls: `${path}.m3u8?${query}`, flv: `${path}.flv?${query}`,
    expiresAt: new Date((now + CSS_PLAY_TTL_SECONDS) * 1000).toISOString(), refreshOnExpiry: true
  };
}

export function verifyCssCallback(body: Record<string, unknown>, now = Math.floor(Date.now() / 1000)) {
  const config = cssConfig();
  const t = body.t;
  const sign = body.sign;
  if (typeof t !== "number" || !Number.isSafeInteger(t) || t < now || t > now + 660 || typeof sign !== "string" || !/^[a-f0-9]{32}$/i.test(sign)) {
    throw new ForbiddenException("CSS 回调签名无效或已过期");
  }
  const expected = createHash("md5").update(config.callbackKey + t).digest();
  if (!timingSafeEqual(Buffer.from(sign, "hex"), expected)) throw new ForbiddenException("CSS 回调签名无效");
  if (body.appid !== config.appId || body.app !== config.pushDomain || body.appname !== CSS_APP) {
    throw new ForbiddenException("CSS 回调来源不匹配");
  }
  return config;
}

export function cssRecordingKey(value: unknown, streamId: string, { bucket, region }: ReturnType<typeof cssConfig>): string {
  if (typeof value !== "string" || value.length > 2048) throw new BadRequestException("CSS 录像地址无效");
  try {
    const url = new URL(value);
    const hosts = [`${bucket}.cos.${region}.myqcloud.com`, `${bucket}.cos-internal.${region}.tencentcos.cn`];
    if (!hosts.includes(url.host) || !["https:", "http:"].includes(url.protocol) || url.username || url.password) throw new Error();
    const key = decodeURIComponent(url.pathname.slice(1));
    if (!key.startsWith(`recordings/css/${streamId}/`) || key.length > 191 || !/^[a-zA-Z0-9_/-]+\.mp4$/i.test(key)) throw new Error();
    return key;
  } catch {
    throw new BadRequestException("CSS 录像必须位于约定的 COS 桶与路径");
  }
}
