export const cloudFields = [
  ["TENCENT_PUSH_DOMAIN", "直播推流域名"], ["TENCENT_PLAY_DOMAIN", "直播播放域名"],
  ["TENCENT_PUSH_KEY", "推流鉴权密钥"], ["TENCENT_PLAY_KEY", "播放鉴权密钥"], ["TENCENT_CALLBACK_KEY", "回调鉴权密钥"],
  ["COS_BUCKET", "COS 存储桶（含 APPID）"], ["COS_REGION", "COS 所属地域"],
  ["COS_SECRET_ID", "COS 子账号 SecretId"], ["COS_SECRET_KEY", "COS 子账号 SecretKey"]
] as const;

export function cloudConfiguration() {
  return cloudFields.map(([name, label]) => {
    const value = process.env[name]?.trim();
    return { name, label, configured: !!value && !/example\.com|replace-with|YOUR_/i.test(value) };
  });
}

export function recordingRetentionDays() {
  const days = Number(process.env.RECORDING_RETENTION_DAYS ?? 30);
  if (!Number.isInteger(days) || days < 1 || days > 3650) throw new Error("RECORDING_RETENTION_DAYS 须为 1～3650 的整数");
  return days;
}
