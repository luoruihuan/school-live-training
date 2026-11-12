import "reflect-metadata";
import test from "node:test";
import assert from "node:assert/strict";
import { detailImageKeys, MAX_DETAIL_IMAGES } from "./business.controller.js";

const VALID_KEY = "product-images/0123456789abcdef0123456789abcdef.jpg";

test("商品详情图：合法 key 数组按原顺序返回", () => {
  const keys = [VALID_KEY, VALID_KEY.replace(".jpg", ".png"), VALID_KEY.replace(".jpg", ".webp")];
  assert.deepEqual(detailImageKeys({ detailImages: keys }), keys);
});

test("商品详情图：未传字段返回 undefined（编辑时表示不改动）", () => {
  assert.equal(detailImageKeys({}), undefined);
});

test("商品详情图：超过上限拒绝", () => {
  assert.throws(() => detailImageKeys({ detailImages: Array(MAX_DETAIL_IMAGES + 1).fill(VALID_KEY) }), /最多/);
  // 恰好等于上限允许
  assert.equal(detailImageKeys({ detailImages: Array(MAX_DETAIL_IMAGES).fill(VALID_KEY) })!.length, MAX_DETAIL_IMAGES);
});

test("商品详情图：非法 key / 非数组 / 非字符串元素拒绝", () => {
  assert.throws(() => detailImageKeys({ detailImages: "not-array" }), /格式不正确/);
  assert.throws(() => detailImageImagesInvalid(), /对象键不正确/);
  assert.throws(() => detailImageKeys({ detailImages: [123] }), /对象键不正确/);
  assert.throws(() => detailImageKeys({ detailImages: ["product-images/../../etc.jpg"] }), /对象键不正确/);
  assert.throws(() => detailImageKeys({ detailImages: ["recordings/0123456789abcdef0123456789abcdef.mp4"] }), /对象键不正确/);
});

function detailImageImagesInvalid(): string[] | undefined {
  return detailImageKeys({ detailImages: ["uploads/0123456789abcdef0123456789abcdef.jpg"] });
}
