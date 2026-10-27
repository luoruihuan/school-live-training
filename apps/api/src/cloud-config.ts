export const cloudFields = [
  ["SRS_SECRET", "SRS 推流鉴权密钥"], ["MINIO_ENDPOINT", "MinIO 存储内网地址"],
  ["MINIO_ROOT_USER", "MinIO 访问用户"], ["MINIO_ROOT_PASSWORD", "MinIO 访问密码"]
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
