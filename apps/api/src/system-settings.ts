import type { PrismaService } from "./prisma.service.js";
import { cdnLiveDomain, replayCdnDomain } from "./cloud-config.js";

export const CDN_LIVE_SWITCH = "cdnLiveEnabled";
export const REPLAY_CDN_SWITCH = "replayCdnEnabled";

/** CDN 开关当前值（默认关闭）。读取失败按"关"处理，绝不影响播放主链路。 */
export async function cdnSwitches(prisma: PrismaService): Promise<{ live: boolean; replay: boolean }> {
  try {
    const rows = await prisma.systemSetting.findMany({
      where: { key: { in: [CDN_LIVE_SWITCH, REPLAY_CDN_SWITCH] } },
      select: { key: true, value: true }
    });
    const map = new Map(rows.map((row) => [row.key, row.value]));
    return { live: map.get(CDN_LIVE_SWITCH) === "true", replay: map.get(REPLAY_CDN_SWITCH) === "true" };
  } catch {
    return { live: false, replay: false };
  }
}

/**
 * 生效中的分发域名 = 环境变量能力配置 × 运行开关。
 * 任一环缺失（未配置 / 开关关闭 / 域名格式非法）都返回 undefined，播放回退直连源站；
 * 配置错误通过 /ops/settings 的 configured/error 字段暴露给运维面板，而不是炸掉播放接口。
 */
export async function effectiveCdnDomains(prisma: PrismaService): Promise<{ live?: string; replay?: string }> {
  const switches = await cdnSwitches(prisma);
  const read = (reader: () => string | undefined): string | undefined => {
    try { return reader(); } catch { return undefined; }
  };
  return {
    live: switches.live ? read(cdnLiveDomain) : undefined,
    replay: switches.replay ? read(replayCdnDomain) : undefined
  };
}
