# 部署与发布流程

> 目标：单人操作、低风险、可回滚、一条命令完成。
>
> 本文档只描述与具体环境无关的流程和约定。服务器地址、域名、账号、云资源名称、备份目标和费用等信息属于部署环境，保存在各自的本地资料中，不写入仓库。

## 一、前置条件

**服务器**

- 已安装 Docker 与 Compose 插件，项目目录约定为 `/srv/live-training`。
- 按下文「发布」一节把仓库代码放到服务器（标准路径不需要服务器访问 GitHub，但需要一个可 SSH 访问的代码源）。
- `deploy/.env` 参照 [`deploy/.env.example`](.env.example) 填写；证书放在 `deploy/tls/`（`fullchain.pem`、`privkey.pem`），或改用前置反向代理（见第七节）。

**本地**

- Docker 已启动。
- `~/.ssh/config` 中已配置服务器别名。
- 代码已提交，工作区干净。

## 二、标准发布：本地构建镜像并传输

```bash
SSH_HOST=<服务器别名> bash deploy/publish.sh
```

`publish.sh` 依次完成：

1. 生成版本号 `<yyyyMMdd-HHmmss>-<短提交号>`；
2. 推送代码：GitHub 推送失败不阻塞，推送到服务器代码源必须成功；
3. 本地构建 `linux/amd64` 的 `api`、`web`、`initialize` 三个镜像；
4. `docker save` 压缩后经 SSH 传输到服务器并加载；
5. 远端执行 `deploy/deploy-images.sh`。

`deploy/deploy-images.sh` 在服务器上完成：备份 → 应用未执行的迁移 → 把当前镜像存档为 `rollback-<时间戳>` 标签 → 应用新镜像 → 重启 → 健康检查（最长 180 秒）。健康检查超时会打印逐条回滚指引。

## 三、备用发布路径：服务器现场构建

服务器可以直连 GitHub 时，也可以在服务器上执行 `deploy/deploy.sh`：拉取代码、备份、迁移、构建、重启和健康检查一步完成。两条路径共用同一套迁移与备份逻辑。

## 四、数据库迁移约定

项目对已有库不做自动迁移，所有结构变更走 `deploy/migrations/` 目录：

1. 新增迁移文件命名为 `NNNNNN-NN-描述.sql`（序号递增），需要回滚时配套同名 `.down.sql`；
2. 迁移只写 DDL 或幂等的 DML，不写业务数据修复；
3. 部署脚本用 `_migrations` 表记账，已应用的文件自动跳过，因此已发布的迁移文件不要改名；
4. `apps/api/prisma/schema.prisma` 与迁移 SQL 必须在同一次提交中保持一致；
5. 大表变更优先选择 `ALGORITHM=INSTANT` 可行的写法，发布前在本地用 `prisma migrate diff` 确认无差异。

## 五、提交、版本与回滚

- 一次发布对应一个或一组可独立回滚的提交：功能、修复、迁移分开提交。
- 每次发布成功后打标签：`git tag v$(date +%Y%m%d)-<序号> && git push --tags`。
- 服务器只运行 `main` 分支，使用 `git pull --ff-only`，不在服务器上手改代码。

| 场景 | 操作 |
| --- | --- |
| 镜像回滚 | 把对应的 `rollback-<时间戳>` 镜像重新标记为 `latest`，执行 `docker compose --env-file deploy/.env -f compose.production.yaml up -d` |
| 代码回滚 | 服务器 `git reset --hard <旧提交或标签>` 后重新发布 |
| 数据回滚 | `zcat backups/pre-deploy-<时间>.sql.gz \| docker exec -i live-training-mysql-1 sh -c "MYSQL_PWD=\$MYSQL_PASSWORD mysql -ulive live_training"` |
| 结构回滚 | 手动执行对应 `*.down.sql`，执行前确认没有依赖新列的数据 |

## 六、巡检

```bash
ssh <服务器别名> 'docker ps --filter name=live-training --format "{{.Names}}\t{{.Status}}"'   # 服务状态
ssh <服务器别名> 'docker logs live-training-api-1 --since 10m 2>&1 | tail -30'                   # 最近日志
ssh <服务器别名> 'ls -la /srv/live-training/backups/'                                             # 发布前备份盘点
```

日常状态优先看管理工作台的「运行监控」页：服务可达性、磁盘、回放存储、今日直播和异常告警都在那里汇总。

## 七、前置反向代理

Web 容器在 8443 端口提供 HTTPS。使用 Caddy 等反向代理前置时，站点片段参照 [`server/caddy-live.example.inc`](server/caddy-live.example.inc)，合并进 `/etc/caddy/Caddyfile` 后执行 `caddy reload`。

上游地址必须写 `https://127.0.0.1:8443`，不要写 `localhost`：`localhost` 会解析出 IPv6 地址，而容器端口只监听 IPv4，请求随机落到 IPv6 会被拒绝，表现为约一半请求返回 502、直播卡顿。修改后连续请求主站 20 次以上应全部返回 200。

## 八、备份

- 每次发布前自动做一次全库备份，保存在服务器 `backups/` 下，按份数滚动保留。
- 回放长期层建议使用对象存储，并由对象存储的生命周期规则按保留期自动清理。
- 异机备份脚本 [`server/backup-to-oracle.sh`](server/backup-to-oracle.sh) 依赖服务器上配置好的 rclone 远程名称和 crontab，按实际环境设置后启用；失败时通过飞书机器人告警。
