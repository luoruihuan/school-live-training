# 腾讯云 CSS 配置与验证

系统支持两条直播线路：自建 SRS 和腾讯云标准直播（CSS）。两条线路对教师和学生保持同一入口，由超级管理员在「系统设置 → 直播线路」切换，开播期间锁定。本文说明接入 CSS 需要在腾讯云控制台完成的配置、对应的环境变量，以及上线前后的验证步骤。

文中的域名、APPID 和密钥均为示例。控制台文档以腾讯云官方为准，本文核对日期为 2026-11-27。

## 1. 添加推流域名和播放域名

进入[云直播控制台](https://console.cloud.tencent.com/live/livestat)的「域名管理」，准备两个域名。

| 用途 | 示例 | 控制台配置 |
| --- | --- | --- |
| OBS 推流 | `<BizID>.push.tlivecloud.com` 或 `push-css.example.com` | 腾讯云默认推流域名已配置 RTMPS 证书。使用自有推流域名时以 `live` 作为推流路径，并通过工单配置 RTMPS 证书 |
| 学生观看 | `play-css.example.com` | 添加为播放域名，加速区域按学生所在网络选择 |

腾讯云提示默认推流域名仅用于测试，正式使用请添加自有推流域名。首次接入自有域名时按控制台提示验证归属，再到 DNS 服务商处为两个域名配置 CNAME。

参考 [添加自有域名](https://cloud.tencent.com/document/product/267/20381) 和 [域名配置常见问题](https://cloud.tencent.com/document/product/267/45252)。

## 2. 配置鉴权

- **推流域名 → 推流配置 → 鉴权配置**：启用推流鉴权，主 KEY 写入 `CSS_PUSH_KEY`。控制台地址生成器的加密类型选择 MD5，可用来核对系统生成的地址格式。
- **播放域名 → 高级配置 → HTTPS 配置**：启用 HTTPS 并选择覆盖播放域名的证书。官方提示证书配置约 2 小时生效。
- **播放域名 → 访问控制 → Key 鉴权**：开启 MD5 Key 鉴权，主 KEY 写入 `CSS_PLAY_KEY`，有效时间填写 `14400` 秒。系统按 `txTime + 14400` 计算过期时间，并在过期前由播放器重新获取地址。

推流默认使用 RTMPS 和 443 端口，适用于限制 TCP 1935 的校园网。只有确认所在网络允许 TCP 1935 时，才显式设置 `CSS_PUSH_PROTOCOL=rtmp`。

参考 [推流鉴权](https://cloud.tencent.com/document/product/267/32833)、[播放鉴权](https://cloud.tencent.com/document/product/267/32463)、[HTTPS 配置](https://cloud.tencent.com/document/product/267/32826)。

## 3. 配置回调和录制

1. **功能配置 → 直播回调 → 创建模板**：「推流回调」「断流回调」「录制文件回调」都填写 `https://<业务域名>/api/webhooks/css`，设置独立的回调密钥（建议 32 位字母数字）并写入 `CSS_CALLBACK_KEY`。模板绑定到**推流域名**。
2. **功能配置 → 直播录制 → 录制存储至 COS → 创建模板**：选择「录制原始流」、仅 MP4，单文件时长可填 120 分钟，存储到私有回放桶 `COS_RECORDINGS_BUCKET`。按控制台提示授权云直播录制服务写入该桶。
3. 存储文件夹填写下面的规则。系统按 `recordings/css/<StreamID>/` 前缀定位对象，其他前缀的录制通知会被拒绝。

   ```text
   recordings/css/{StreamID}/{RecordId}/{StartYear}-{StartMonth}-{StartDay}-{StartHour}-{StartMinute}-{StartSecond}-{RandomID}
   ```

4. 录制模板同样绑定到**推流域名**。模板生效约需 5 到 10 分钟，录像一般在关播后数秒到数分钟内入库。

参考 [直播回调设置](https://cloud.tencent.com/document/product/267/20388)、[回调数据和重试](https://cloud.tencent.com/document/product/267/32744)、[录制存储至 COS](https://cloud.tencent.com/document/product/267/85691)。

## 4. 延迟配置与自适应码率

HLS 的延迟由切片时长和缓冲片数决定，切片不能短于推流的关键帧间隔（GOP）。

**延迟配置**：推流域名 → 高级配置 → 延迟配置，选「低」（2 秒 × 3 片，GOP 为 2 秒时官方预估延迟 6 到 8 秒）。延迟越低缓冲越薄，建议先压低码率再调低延迟。

**自适应码率**：在「功能配置 → 多码率自适应」创建模板并绑定到**播放域名**，学生端会按网络状况在档位之间自动切换，弱网时降低清晰度而不是卡住。建议配置：

| 子流 | 视频码率 | 分辨率（高） | 编码 | GOP | 参数限制 |
| --- | --- | --- | --- | --- | --- |
| `hd720` | 2000 Kbps | 720 | H.264 | 2 秒 | 不超过原始高度、帧率和码率 |
| `sd480` | 1000 Kbps | 480 | H.264 | 2 秒 | 同上 |

- 所有子流必须使用相同的编码和 GOP。
- 模板里固定 GOP 为 2 秒，教师忘记调整 OBS 关键帧间隔时，自适应流仍是 2 秒切片。
- 自适应码率仅支持 HLS。系统生成的 HLS 地址为 `<StreamID>_<模板名>.m3u8`，鉴权串按带后缀的流名计算；HTTP-FLV 地址仍是原始流。
- 自适应码率按档位、按分钟计费，观众拉流时才启动。

参考 [延迟配置](https://cloud.tencent.com/document/product/267/73788)、[直播自适应码率](https://cloud.tencent.com/document/product/267/78369)、[直播延迟问题排查](https://cloud.tencent.com/document/product/267/7971)。

## 5. 部署与启用

1. 在服务器 `deploy/.env` 填写以下值，说明见 [`deploy/.env.example`](.env.example)。`CSS_APP_ID` 是开通云直播的账号 APPID；`COS_*` 沿用回放存储配置。

   ```dotenv
   CSS_PUSH_DOMAIN=<BizID>.push.tlivecloud.com
   CSS_PLAY_DOMAIN=play-css.example.com
   CSS_PUSH_PROTOCOL=rtmps
   CSS_PUSH_KEY=
   CSS_PLAY_KEY=
   CSS_CALLBACK_KEY=
   CSS_APP_ID=
   CSS_ABR_TEMPLATE=<自适应码率模板名>
   ```

   `CSS_ABR_TEMPLATE` 留空时 HLS 播放原始流，可作为应急开关。

2. 按发布流程上线代码。首次接入已有数据库时先备份，再应用迁移 [`migrations/20261124-01-css-stream.sql`](migrations/20261124-01-css-stream.sql)。
3. 在「系统设置 → 直播线路」选择「腾讯云标准直播（CSS）」。配置不完整时该选项不可选，页面会显示缺失项。「自适应码率」一行显示模板是否启用。
4. 教师在测试课堂重新获取 OBS 设置。切换线路后，所有教师都需要在下次开播前重新获取。

## 6. 教师端 OBS 设置

在 OBS「设置 → 输出」中：码率 1080p 填 4000 Kbps，720p 填 2000 Kbps；关键帧间隔填 2 秒，不要用「自动」。码率再高画质提升很小，却会加重上行网络负担。

## 7. 验证清单

上线后推流 1 到 2 分钟，逐项确认：

- 学生用原课堂链接能播放；浏览器控制台里播放器日志的 `manifest_parsed` 事件中，启用自适应码率时 `levels` 等于子流数量。
- 关播后课堂状态变为已结束，回放在数秒到数分钟内入库，可播放、可拖动。
- 「运行监控 → 今日直播」显示这一场的时长、中断重连次数和回放入库延迟。
- 端到端延迟约 6 到 8 秒，可用画面中的时钟对照。
- 在校园网下测试一次断开重连。

## 8. 排障

| 现象 | 优先检查 |
| --- | --- |
| OBS 推流成功但课堂状态未更新 | 控制台的回调记录、HTTP 状态和回调目标，`CSS_CALLBACK_KEY` 与模板是否绑定在推流域名 |
| 播放返回 403 | 播放鉴权密钥和 14400 秒有效期 |
| 启用自适应码率后无法播放 | 模板是否绑定在播放域名、`CSS_ABR_TEMPLATE` 与模板名是否一致；留空可立即回退为原始流 |
| 延迟仍然很大 | 延迟配置是否为「低」、OBS 关键帧间隔是否为 2 秒 |
| 学生端卡顿 | 先看「运行监控」的今日直播是否有多次中断重连；腾讯云的转码与流量用量在云直播控制台「计费用量」查看 |
| 对象存储里已有录像但平台没有回放 | 录制回调的对象路径是否符合第 3 节的前缀，API 的对象存储读取权限 |
