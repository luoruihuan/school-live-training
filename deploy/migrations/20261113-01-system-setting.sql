-- 20261113-01-system-setting.sql
-- 系统设置 KV 表：当前仅存 CDN 分发开关（cdnLiveEnabled / replayCdnEnabled，value 为 "true"/"false"）。
-- 开关仅控制"是否启用"，域名与鉴权密钥仍在环境变量（能力层与运营层分离）。
CREATE TABLE IF NOT EXISTS `SystemSetting` (
    `key` VARCHAR(50) NOT NULL,
    `value` VARCHAR(500) NOT NULL,
    `updatedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    PRIMARY KEY (`key`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
