-- 20261112-02-coupon-minspend.down.sql
-- 回滚：删除优惠券满减门槛列（已按门槛发放的历史券将退回无门槛语义）
ALTER TABLE `Coupon` DROP COLUMN `minSpend`;
