# school-live-training 项目工作规则

## 部署与代码修改流程（必守）

1. **所有代码修改在本地工作区完成**（即本目录），禁止直接修改服务器 `/srv/live-training` 上的文件（临时排查可只读查看）。
2. 改完在本地 `commit`，然后同步到服务器。**服务器连不上 GitHub**，用 git 直推中转仓库：
   ```bash
   git push origin main        # 同步 GitHub
   git push prod main          # 推到服务器中转仓库(ssh://server/srv/git/school-live.git)
   ssh server        # 然后在服务器 /srv/live-training:
   #   sudo git fetch prod-bare && sudo git merge --ff-only prod-bare/main
   ```
   工作区必须保持干净再合并，否则会挡住 ff（这正是禁止直改服务器文件的原因）。
3. 构建 & 发布（服务器上执行，compose 文件在 `/srv/live-training`）：
   ```bash
   cd /srv/live-training && sudo docker compose -f compose.production.yaml --env-file deploy/.env build <服务>
   sudo docker compose -f compose.production.yaml --env-file deploy/.env up -d <服务>
   ```
4. 一次性初始化容器 `initialize` 处于 Exited(0) 是正常状态。

## 生产环境要点（2026-11-23 记录）

- 服务器：腾讯云轻量（上海 203.0.113.10，2核2G，**出口带宽仅 5Mbps**，400GB/月流量包）；SSH 别名 `server`（ubuntu）。
- 推流：RTMP `:2095`（1935 在部分链路被拦，勿改回）。
- 观看：**HLS 优先**（2026-11-23 从 FLV 切换，源站回源收敛为每 CDN 中间源集群一路，约 2.2Mbps/集群）；SRS `hls_ctx/hls_ts_ctx` 必须保持 off（开了 CDN 缓存失效）；nginx 对 `.ts` 发 `max-age=86400`。
- CDN：腾讯云标准 CDN（非 CSS）。合并回源已开；分片回源已关；中间源默认内置不可见。HTTPS 请求费月 300 万次内免费。
- 回放：CDN→COS，与源站解耦；COS 转存走内网（169.254.x）不占公网带宽。
- OBS 参数规范：720p→2000Kbps、1080p→4000Kbps；**直播中禁止改分辨率/帧率**（等同断流）。
- 已知容量边界：5M 带宽下跨 2 个运营商集群回源（2×2.2M）即贴上限，商用前需升带宽或降码率。
