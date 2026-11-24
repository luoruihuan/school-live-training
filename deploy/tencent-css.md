# 腾讯云 CSS 配置与验证

官方控制台文档核对日期为 2026-11-24。平台默认使用上海自建线路。超管可在「系统设置 → 直播线路」选择腾讯云标准直播，开播期间选项锁定。教师继续使用「获取 OBS 设置」，学生继续打开原课堂链接。

## 1. 添加推流和播放域名

登录[腾讯云云直播控制台](https://console.cloud.tencent.com/live/livestat)，进入「域名管理」，使用已备案主域名下的两个独立子域名。以下域名为示例。

| 用途 | 示例 | 控制台配置 |
| --- | --- | --- |
| OBS 推流 | `push-css.example.com` | 添加为推流域名，使用 `live` 作为推流路径 |
| 学生观看 | `play-css.example.com` | 添加为播放域名，加速区域选「中国大陆」 |

首次接入时按控制台提示验证域名归属，再在 DNS 服务商处把两个子域名分别 CNAME 到控制台提供的目标。业务域名和回放域名继续指向原有服务。

参考 [添加自有域名](https://cloud.tencent.com/document/product/267/20381) 和 [域名配置常见问题](https://cloud.tencent.com/document/product/267/45252)。

## 2. 配置推流和播放鉴权

- **推流域名 → 推流配置 → 鉴权配置**。启用推流鉴权，把主 KEY 写入 `CSS_PUSH_KEY`。控制台地址生成器的加密类型选择 **MD5**，可用来核对项目生成的格式。默认采用 RTMP。
- **播放域名 → 高级配置 → HTTPS 配置**。启用 HTTPS，选择或上传覆盖播放域名的证书。官方文档提示证书配置约 2 小时生效。
- **播放域名 → 访问控制 → Key 鉴权**。开启 MD5 Key 鉴权，把主 KEY 写入 `CSS_PLAY_KEY`，有效时间填写 **`14400` 秒**。平台按腾讯云规则以 `txTime + 14400` 计算过期时间，并在过期前通过应用接口重新签发地址。
- CSS 播放域名默认提供 `Access-Control-Allow-Origin`。用学生端实际加载 HLS 清单和分片验证响应头。

校园网如果拦截 RTMP 默认端口 1935，可在腾讯云工单中为自有推流域名申请 RTMPS 证书配置。确认生效并在校园网 OBS 试推后，把 `CSS_PUSH_PROTOCOL` 改为 `rtmps`。

参考 [推流鉴权](https://cloud.tencent.com/document/product/267/32833)、[播放鉴权](https://cloud.tencent.com/document/product/267/32463)、[HTTPS](https://cloud.tencent.com/document/product/267/32826)、[HTTP 响应头](https://cloud.tencent.com/document/product/267/76557) 和 [RTMPS](https://cloud.tencent.com/document/product/267/56843)。

## 3. 配置回调与 COS 录制

1. **功能配置 → 直播回调 → 创建模板**。把「推流回调」「断流回调」「录制文件回调」都填为 `https://<业务域名>/api/webhooks/css`。设置独立回调密钥，建议 32 位字母数字，写入 `CSS_CALLBACK_KEY`。将模板绑定到 **推流域名**。
2. **功能配置 → 直播录制 → 录制存储至 COS → 创建模板**。选择「录制原始流」、**仅 MP4**、单文件时长可填 **120 分钟**，存储路径选择平台现有的私有回放桶 `COS_RECORDINGS_BUCKET`。按照控制台提示给云直播录制服务授权，让其能在选定桶中写入录像。
3. **存储文件夹**填写下面的规则。平台按 `recordings/css/<StreamID>/` 前缀定位对象，由现有回放桶和回放 CDN 提供播放。

   ```text
   recordings/css/{StreamID}/{RecordId}/{StartYear}-{StartMonth}-{StartDay}-{StartHour}-{StartMinute}-{StartSecond}-{RandomID}
   ```

4. 将录制模板也绑定到 **推流域名**。腾讯云文档给出的模板生效时间约 5–10 分钟，录像通常在录制结束约 5 分钟后可用。录制后处理、转码、截图和快直播可保持默认设置。

参考 [直播回调设置](https://cloud.tencent.com/document/product/267/20388)、[回调数据和重试](https://cloud.tencent.com/document/product/267/32744)、[录制存储至 COS](https://cloud.tencent.com/document/product/267/85691) 和 [录制文件通知](https://cloud.tencent.com/document/product/267/47026)。

## 4. 部署与启用

1. 在服务器 `deploy/.env` 填写以下值。`CSS_APP_ID` 是开通云直播的腾讯云账号数字 APPID。在腾讯云控制台的「账号信息」页查看。现有 `COS_ENDPOINT`、`COS_REGION`、`COS_RECORDINGS_BUCKET` 及 COS 访问密钥沿用回放配置。

   ```dotenv
   CSS_PUSH_DOMAIN=push-css.example.com
   CSS_PLAY_DOMAIN=play-css.example.com
   CSS_PUSH_PROTOCOL=rtmp
   CSS_PUSH_KEY=
   CSS_PLAY_KEY=
   CSS_CALLBACK_KEY=
   CSS_APP_ID=
   ```

2. 按项目发布流程合并并同步代码。已有数据库先备份，再应用迁移 [`20261124-01-css-stream.sql`](migrations/20261124-01-css-stream.sql)，然后发布 API 和 Web。
3. API 读入配置后，在平台「系统设置 → 直播线路」选择「腾讯云标准直播（CSS）」。以超管页面的字段提示核对配置。该页面校验服务端参数是否齐全，域名、证书与模板以腾讯云控制台和试播结果为准。
4. 教师在测试课堂重新获取 OBS 设置，使用 H.264 + AAC 推流 1–2 分钟。用学生账号确认原课堂链接能播放，停止 OBS 后确认课堂变为已结束，再在 COS 和平台回放列表确认 MP4 已入库、可播放和拖动。试播时用实际校园网测试推流与一次断开重连。
5. 测试完成后可以在所有课堂停播时切回「上海自建（SRS）」。教师下一次开播前用相同入口重新获取 OBS 设置。切回后仍会接收已开始的 CSS 录制任务的迟到回调，因此保留 CSS 回调模板和环境配置。

如果 OBS 推流成功而课堂状态未更新，先查看云直播控制台的回调记录、HTTP 状态和回调目标。HTTPS 403 优先检查播放鉴权密钥和 `14400` 秒有效期。若 COS 已出现录像而平台没有回放，核对录制文件回调的 `video_url` 是否对应选定桶和配置的前缀，再核对 API 的 COS 读取权限。
