import { createHash } from "node:crypto";

export const cloudFields = [
  ["SRS_SECRET", "SRS 推流鉴权密钥"], ["MINIO_ENDPOINT", "MinIO 存储内网地址"],
  ["MINIO_ROOT_USER", "MinIO 访问用户"], ["MINIO_ROOT_PASSWORD", "MinIO 访问密码"],
  ["CDN_LIVE_DOMAIN", "直播 CDN 分发域名（可选）"], ["REPLAY_CDN_DOMAIN", "回放 CDN 分发域名（可选）"],
  ["CDN_URL_AUTH_KEY", "回放 URL 鉴权密钥（可选）"]
] as const;

export function cloudConfiguration() {
  return cloudFields.map(([name, label]) => {
    const value = process.env[name]?.trim();
    return { name, label, configured: !!value && !/example\.com|replace-with|YOUR_/i.test(value) };
  });
}

export function recordingRetentionDays() {
  const days = Number(process.env.RECORDING_RETENTION_DAYS ?? 180);
  if (!Number.isInteger(days) || days < 1 || days > 3650) throw new Error("RECORDING_RETENTION_DAYS 须为 1～3650 的整数");
  return days;
}

/** 域名清洗：容忍误带的 https:// 前缀与尾部斜杠，其余格式不对直接报错。 */
function normalizeDomain(envName: string): string | undefined {
  const raw = process.env[envName]?.trim();
  if (!raw) return undefined;
  const domain = raw.replace(/^https?:\/\//i, "").replace(/\/+$/, "");
  if (!/^[a-zA-Z0-9]([a-zA-Z0-9-]*[a-zA-Z0-9])?(\.[a-zA-Z0-9]([a-zA-Z0-9-]*[a-zA-Z0-9])?)+$/.test(domain)) {
    throw new Error(`${envName} 须为域名（不要带协议与路径）：${raw}`);
  }
  return domain;
}

/** 直播 CDN 分发域名；未配置时回退直连源站（APP_DOMAIN）。 */
export function cdnLiveDomain(): string | undefined {
  return normalizeDomain("CDN_LIVE_DOMAIN");
}

/** 回放 CDN 分发域名（绑 COS 桶的加速域名）；未配置时回放仍走 API 代理。 */
export function replayCdnDomain(): string | undefined {
  return normalizeDomain("REPLAY_CDN_DOMAIN");
}

/** 回放 URL 鉴权密钥（腾讯云 CDN TypeA 主密钥）；未配置则回放 URL 不带签名。 */
export function cdnUrlAuthKey(): string | undefined {
  const key = process.env.CDN_URL_AUTH_KEY?.trim();
  return key || undefined;
}

/** 回放 CDN 直连 URL 的约定有效时长（秒），需与 CDN 控制台 TypeA 鉴权有效时长保持一致。 */
export const REPLAY_URL_TTL_SECONDS = 6 * 60 * 60;

/** 腾讯云 CDN URL 鉴权 TypeA 纯函数（便于用官方文档向量做单测）：
 *  URL：https://{domain}{uri}?sign={timestamp}-{rand}-{uid}-{md5hash}
 *  md5hash = md5(uri-timestamp-rand-uid-主密钥)，timestamp 为十进制 Unix 秒。 */
export function cdnTypeAUrl(domain: string, uri: string, authKey: string, timestampSec: number, rand: string): string {
  const path = uri.startsWith("/") ? uri : `/${uri}`;
  const timestamp = String(timestampSec);
  const uid = "0";
  const md5hash = createHash("md5").update(`${path}-${timestamp}-${rand}-${uid}-${authKey}`).digest("hex");
  return `https://${domain}${path}?sign=${timestamp}-${rand}-${uid}-${md5hash}`;
}
