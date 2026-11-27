import { Injectable, Logger } from "@nestjs/common";

const DISK_ALERT_PERCENT = 80;
const DISK_RECOVER_PERCENT = 75;

export type AlertDelivery = { at: Date; ok: boolean; error?: string };

/**
 * 飞书机器人告警：磁盘水位、回放清理等关键事件通知。
 * 发送失败只记日志，绝不影响主流程；未配置 webhook 时自动静默。
 */
@Injectable()
export class AlertService {
  private readonly logger = new Logger(AlertService.name);
  private diskAlerted = false;
  private lastDelivery: AlertDelivery | null = null;

  /** 是否配置了飞书机器人 webhook。 */
  get configured(): boolean {
    return Boolean(process.env.FEISHU_WEBHOOK_URL?.trim());
  }

  /** 最近一次发送结果；未配置或启动后还没发送过时 last 为 null。 */
  status(): { configured: boolean; last: AlertDelivery | null } {
    return { configured: this.configured, last: this.lastDelivery };
  }

  async send(text: string): Promise<void> {
    const url = process.env.FEISHU_WEBHOOK_URL?.trim();
    if (!url) return;
    const at = new Date();
    try {
      const response = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ msg_type: "text", content: { text } }),
        signal: AbortSignal.timeout(8000)
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      // 飞书对关键字或签名不匹配也可能返回 200，要看响应体里的业务码。
      const body = await response.json().catch(() => null) as { code?: number; StatusCode?: number; msg?: string } | null;
      const code = body?.code ?? body?.StatusCode;
      if (code !== undefined && code !== 0) throw new Error(`飞书返回 code=${code}${body?.msg ? `（${body.msg}）` : ""}`);
      this.lastDelivery = { at, ok: true };
    } catch (error) {
      this.lastDelivery = { at, ok: false, error: error instanceof Error ? error.message : String(error) };
      this.logger.error(`飞书告警发送失败：${String(error)}`);
    }
  }

  /** 磁盘巡检：首次升破 80% 告警一次，回落到 75% 以下重置并通知恢复。 */
  async checkDisk(percent: number | null): Promise<void> {
    if (percent === null) return;
    if (!this.diskAlerted && percent >= DISK_ALERT_PERCENT) {
      this.diskAlerted = true;
      await this.send(`[磁盘] 服务器本地磁盘使用率 ${percent}%（阈值 ${DISK_ALERT_PERCENT}%）。\n本地盘存放数据库与系统文件，回放存储不占此盘。请检查 Docker 镜像、容器日志或数据库占用。`);
    } else if (this.diskAlerted && percent < DISK_RECOVER_PERCENT) {
      this.diskAlerted = false;
      await this.send(`[磁盘] 服务器本地磁盘使用率回落到 ${percent}%，此前的磁盘告警解除。`);
    }
  }
}
