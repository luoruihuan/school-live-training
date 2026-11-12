-- 20261112-02-coupon-minspend.sql
-- 优惠券满减门槛：适用商品合计达到 minSpend 积分才能抵扣；0 = 无门槛（历史券全部兼容）
ALTER TABLE `Coupon` ADD COLUMN `minSpend` INTEGER NOT NULL DEFAULT 0;
