import { Injectable, Logger } from "@nestjs/common";

const DISK_ALERT_PERCENT = 80;
const DISK_RECOVER_PERCENT = 75;

/**
 * 飞书机器人告警：磁盘水位、回放清理等关键事件通知。
 * 发送失败只记日志，绝不影响主流程；未配置 webhook 时自动静默。
 */
@Injectable()
export class AlertService {
  private readonly logger = new Logger(AlertService.name);
  private diskAlerted = false;

  async send(text: string): Promise<void> {
    const url = process.env.FEISHU_WEBHOOK_URL?.trim();
    if (!url) return;
    try {
      const response = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ msg_type: "text", content: { text } }),
        signal: AbortSignal.timeout(8000)
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
    } catch (error) {
      this.logger.error(`飞书告警发送失败：${String(error)}`);
    }
  }

  /** 磁盘巡检：首次升破 80% 告警一次，回落到 75% 以下重置并通知恢复。 */
  async checkDisk(percent: number | null): Promise<void> {
    if (percent === null) return;
    if (!this.diskAlerted && percent >= DISK_ALERT_PERCENT) {
      this.diskAlerted = true;
      await this.send(`[disk warn] Disk usage ${percent}% (threshold ${DISK_ALERT_PERCENT}%).\nAuto cleanup will start at 85%. Please check replays or plan more storage.`);
    } else if (this.diskAlerted && percent < DISK_RECOVER_PERCENT) {
      this.diskAlerted = false;
      await this.send(`[disk ok] Disk usage back to ${percent}% (< ${DISK_RECOVER_PERCENT}%), previous disk alert cleared.`);
    }
  }
}
