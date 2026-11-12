# 发布流程规范（内部系统）

> 目标：单人、低风险、可回滚、一条命令完成。适用 `/srv/live-training`（腾讯东京）。

## 一、日常发布（标准路径）

```bash
# 本地：提交改动并推送
git add -A && git commit -m "feat: xxx" && git push origin main

# 触发发布（本地一条命令，或在服务器上执行 deploy/deploy.sh）
ssh tokyo 'bash /srv/live-training/deploy/deploy.sh'
```

`deploy.sh` 自动完成：记录版本 → 拉取代码 → 全库备份（保留最近 10 份）→ 应用未执行的迁移 → 构建镜像 → 重启 → 健康检查（180s）；失败时打印逐条回滚指引。

## 二、数据库迁移约定（重点）

项目对已有库不做自动迁移（结构不一致时 initialize 容器会阻止部署），因此所有结构变更走 `deploy/migrations/` 目录：

1. 新增迁移文件：`NNNNNN-NN-描述.sql`（序号递增），有回滚需求时配套 `同名.down.sql`；
2. 迁移必须可重复评审：只写 DDL/幂等 DML，不写业务数据修复；
3. 部署脚本用 `_migrations` 表记账，已应用的文件自动跳过——**改过的迁移文件不要改名**；
4. `prisma/schema.prisma` 与迁移 SQL 必须同一次提交，保持一致；
5. 大表变更（未来）优先 `ALGORITHM=INSTANT` 可行的写法，发布前先在本地验证 `prisma migrate diff` 无差异。

## 三、提交与版本约定

- 一次发布对应一个或一组**可独立回滚**的提交：功能、修复、迁移分开提交，不混在一起；
- 每次发布成功后打标签：`git tag v$(date +%Y%m%d)-<序号> && git push --tags`（回滚时可直接定位）；
- 生产只跑 `main` 分支，`git pull --ff-only`，服务器上禁止手改代码（改动会被下次发布冲掉）。

## 四、回滚手册

| 场景 | 操作 |
|---|---|
| 代码回滚 | 服务器 `git reset --hard <旧commit或tag>` 后重跑 `deploy/deploy.sh` |
| 数据回滚 | `zcat backups/pre-deploy-<时间>.sql.gz \| docker exec -i live-training-mysql-1 sh -c "MYSQL_PWD=\$MYSQL_PASSWORD mysql -ulive live_training"` |
| 结构回滚 | 手动执行对应 `*.down.sql`（回滚前确认无依赖新列的数据） |

## 五、常规巡检

```bash
ssh tokyo 'docker ps --filter name=live-training --format "{{.Names}}\t{{.Status}}"'          # 服务状态
ssh tokyo 'docker logs live-training-api-1 --since 10m 2>&1 | tail -30'                        # 最近日志
ssh tokyo 'ls -la /srv/live-training/backups/'                                                  # 备份盘点
```

## 五点五、备份与回放存储（2026-11-12 起）

- 回放长期层：腾讯 COS 桶 `live-recordings-1319925518`（东京，同地域内网免流量费）；
  API 通过 S3 兼容接口读写，objectKey 不变；清空 .env 中 COS_* 变量即整体回退 MinIO（存量已双向同步）。
- 每日备份：`/usr/local/bin/backup-to-cos.sh`（root crontab 03:15）→ COS 桶 `live-backup-1319925518`
  （mysql dump + 商品图 + legacy 录像）；Oracle 桶降级为每周日 03:20 跨云兜底。
- COS 桶生命周期：recordings 桶 180 天自动删除（与 RECORDING_RETENTION_DAYS 对齐）+ 30 天清理上传碎片。

## 六、已登记的迁移

| 文件 | 内容 | 应用时间 |
|---|---|---|
| 20261109-01-add-istest.sql | 五表增加 isTest 测试侧标记列 | 2026-11-09（手动执行后补登记） |
| 20261112-01-product-detail-images.sql | 商品详情介绍图表 ProductDetailImage | 未发布（随本轮功能上线） |
| 20261112-02-coupon-minspend.sql | 优惠券满减门槛列 minSpend（0=无门槛） | 未发布（随本轮功能上线） |
