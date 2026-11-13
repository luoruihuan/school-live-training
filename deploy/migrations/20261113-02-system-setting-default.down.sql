-- 20261113-02-system-setting-default.down.sql
-- 回滚：恢复 01 版本的列定义（带数据库默认值）。注意回滚后与 Prisma schema 不一致，仅用于退库结构。
ALTER TABLE `SystemSetting` MODIFY `updatedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3);
