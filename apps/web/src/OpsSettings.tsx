import { useCallback, useEffect, useState } from "react";
import { Alert, App, Button, Card, Select, Switch, Tag, Typography } from "antd";
import { api, patch } from "./api";

type LiveProvider = "SRS" | "CSS";
type CdnStatus = { enabled: boolean; configured: boolean; domain: string | null; error: string | null; expectedAuthTtlSeconds?: number };
type Settings = {
  liveProvider: { value: LiveProvider; cssConfigured: boolean; cssError: string | null; abr: { enabled: boolean; template: string | null } };
  cdnLive: CdnStatus;
  replayCdn: CdnStatus;
};

const providerLabel: Record<LiveProvider, string> = { SRS: "上海自建（SRS）", CSS: "腾讯云标准直播（CSS）" };

export function OpsSettings() {
  const { message } = App.useApp();
  const [settings, setSettings] = useState<Settings>();
  const [liveActive, setLiveActive] = useState(false);
  const [error, setError] = useState("");
  const [switching, setSwitching] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setError("");
    try {
      const [config, status] = await Promise.all([api<Settings>("/ops/settings"), api<{ active: boolean }>("/ops/live-status")]);
      setSettings(config); setLiveActive(status.active);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "读取失败");
    }
  }, []);

  useEffect(() => { void refresh(); }, [refresh]);

  async function toggleCdn(field: "cdnLiveEnabled" | "replayCdnEnabled", value: boolean, label: string) {
    setSwitching(field);
    try {
      setSettings(await patch<Settings>("/ops/settings", { [field]: value }));
      void message.success(value ? `${label}已开启` : `${label}已关闭`);
    } catch (reason) {
      void message.error(reason instanceof Error ? reason.message : "切换失败");
    } finally { setSwitching(null); }
  }

  async function selectLiveProvider(provider: LiveProvider) {
    setSwitching("liveProvider");
    try {
      setSettings(await patch<Settings>("/ops/live-provider", { provider }));
      void message.success(`已切换为${providerLabel[provider]}`);
      await refresh();
    } catch (reason) {
      void message.error(reason instanceof Error ? reason.message : "切换直播线路失败");
    } finally { setSwitching(null); }
  }

  if (!settings) return error
    ? <Alert type="error" showIcon title={error} action={<Button size="small" onClick={() => void refresh()}>重试</Button>} />
    : <Card loading />;

  const provider = settings.liveProvider.value;
  const css = provider === "CSS";
  const cdnRows: { key: "replayCdn" | "cdnLive"; label: string; field: "replayCdnEnabled" | "cdnLiveEnabled"; hint: string }[] = [
    { key: "replayCdn", label: "回放走 CDN", field: "replayCdnEnabled", hint: "回放直连 COS 加速域名，不再经服务器代理" },
    ...(css ? [] : [{ key: "cdnLive" as const, label: "上海自建直播走 CDN", field: "cdnLiveEnabled" as const, hint: "观众从 CDN 拉流，源站只出回源流量（源站出口 5 Mbps，多人观看请开启）" }])
  ];

  return <>
    {error && <Alert type="error" showIcon title={error} action={<Button size="small" onClick={() => void refresh()}>重试</Button>} className="spaced" />}

    <div className="ops-grid">
      <Card title="直播" className="ops-grid__full">
        <div className="setting-list">
          <div className="setting-row">
            <span className="setting-row__name">直播线路</span>
            <span className="setting-row__value">{providerLabel[provider]}</span>
            <Select aria-label="直播线路" value={provider} loading={switching === "liveProvider"} disabled={switching !== null || liveActive} style={{ width: 220 }}
              options={([
                { value: "SRS", label: providerLabel.SRS },
                { value: "CSS", label: providerLabel.CSS, disabled: !settings.liveProvider.cssConfigured }
              ] satisfies { value: LiveProvider; label: string; disabled?: boolean }[])}
              onChange={(value) => void selectLiveProvider(value)} />
            <div className="setting-row__note">
              {liveActive ? "有课堂正在直播，停播后可以切换。" : "切换后，请教师开播前重新获取 OBS 设置。"}
              {settings.liveProvider.cssError && <> 腾讯云线路暂不可选：{settings.liveProvider.cssError}</>}
            </div>
          </div>
          <div className="setting-row">
            <span className="setting-row__name">自适应码率</span>
            <span className="setting-row__value">{!css ? "当前线路不适用" : settings.liveProvider.abr.enabled ? `已启用 · ${settings.liveProvider.abr.template}` : "未启用"}</span>
            <Tag color={!css ? "default" : settings.liveProvider.abr.enabled ? "green" : "gold"}>{!css ? "仅腾讯云线路" : settings.liveProvider.abr.enabled ? "生效中" : "原始流"}</Tag>
            <div className="setting-row__note">学生端按网络状况在播放域名绑定的档位间自动切换，弱网时降低清晰度而不是卡住。在服务器 .env 设置 CSS_ABR_TEMPLATE，留空即回退为原始流。</div>
          </div>
        </div>
      </Card>

      <Card title="分发" className="ops-grid__full">
        <div className="setting-list">
          {cdnRows.map(({ key, label, field, hint }) => {
            const status = settings[key];
            const note = status.error ?? (status.configured ? `${hint}（${status.domain}${status.expectedAuthTtlSeconds ? `，控制台 TypeA 有效时长需为 ${status.expectedAuthTtlSeconds} 秒` : ""}）` : "未配置：请在服务器 .env 设置对应域名并重新部署后可开启");
            return <div className="setting-row" key={key}>
              <span className="setting-row__name">{label}</span>
              <span className="setting-row__value">{status.enabled ? "已开启" : "已关闭"}</span>
              <Switch aria-label={label} loading={switching === field} disabled={switching !== null || !status.configured} checked={status.enabled} onChange={(value) => void toggleCdn(field, value, label)} />
              <div className="setting-row__note">{note}</div>
            </div>;
          })}
        </div>
      </Card>
    </div>
    <Typography.Paragraph type="secondary" className="ops-note">修改会记入操作日志。</Typography.Paragraph>
  </>;
}
