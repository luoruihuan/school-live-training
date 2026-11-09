-- 20261109-01-add-istest.down.sql
-- 回滚：删除数据侧标记列。注意：回滚前应确认没有 isTest=TRUE 的行，或明确接受测试数据被并入正式侧。
ALTER TABLE `Coupon` DROP COLUMN `isTest`;
ALTER TABLE `Product` DROP COLUMN `isTest`;
ALTER TABLE `Room` DROP COLUMN `isTest`;
ALTER TABLE `Store` DROP COLUMN `isTest`;
ALTER TABLE `User` DROP COLUMN `isTest`;
