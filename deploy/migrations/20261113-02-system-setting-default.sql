-- 20261113-02-system-setting-default.sql
-- 修正 01 迁移的列默认值：Prisma @updatedAt 期望 updatedAt 无数据库层 DEFAULT（由客户端写入），
-- 01 里误加的 DEFAULT CURRENT_TIMESTAMP(3) 会导致 initialize 的 migrate diff 校验不一致。
ALTER TABLE `SystemSetting` MODIFY `updatedAt` DATETIME(3) NOT NULL;
