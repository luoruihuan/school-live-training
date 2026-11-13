-- 20261113-01-system-setting.down.sql
-- 回滚：删除系统设置表。CDN 开关状态会丢失，回滚后系统按"未开启 CDN"处理（直连源站）。
DROP TABLE IF EXISTS `SystemSetting`;
