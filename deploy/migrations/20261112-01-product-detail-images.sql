-- 20261112-01-product-detail-images.sql
-- 商品详情介绍图：新增 ProductDetailImage 子表（每商品最多 9 张，position 排序）
-- DDL 由 prisma migrate diff 生成，保证与 schema.prisma 期望结构一致（init-db 的 diff 校验依赖这一点）。
CREATE TABLE IF NOT EXISTS `ProductDetailImage` (
    `id` VARCHAR(191) NOT NULL,
    `productId` VARCHAR(191) NOT NULL,
    `imageKey` VARCHAR(200) NOT NULL,
    `position` INTEGER NOT NULL DEFAULT 0,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `ProductDetailImage_productId_position_idx`(`productId`, `position`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

ALTER TABLE `ProductDetailImage` ADD CONSTRAINT `ProductDetailImage_productId_fkey` FOREIGN KEY (`productId`) REFERENCES `Product`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
