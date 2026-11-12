-- 20261112-01-product-detail-images.down.sql
-- 回滚：删除商品详情图表。MinIO 中已上传的详情图对象将成为孤儿，如需彻底回滚请另行清理。
DROP TABLE IF EXISTS `ProductDetailImage`;
