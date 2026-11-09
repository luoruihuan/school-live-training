import { BadRequestException, NotFoundException } from "@nestjs/common";
import type { CurrentUser } from "./auth.service.js";

/**
 * 数据分侧（正式 / 测试）规则：
 * - 超级管理员（SUPER_ADMIN）看全部数据，其创建的数据一律标记 isTest = true（测试侧）；
 * - 其余用户按自身 isTest 归侧，只能看到同侧数据，两侧互不可见。
 */
export function isTestCreator(user: CurrentUser): boolean {
  return user.role === "SUPER_ADMIN";
}

/** 列表查询的 where 片段：超管不过滤，其余用户只看同侧。 */
export function dataScope(user: CurrentUser & { isTest?: boolean }): { isTest: boolean } | undefined {
  if (user.role === "SUPER_ADMIN") return undefined;
  return { isTest: user.isTest ?? false };
}

/** 单条数据同侧校验：不存在或跨侧一律按“不存在”处理；超管放行。 */
export function scoped<T extends { isTest?: boolean }>(entity: T | null | undefined, user: CurrentUser & { isTest?: boolean }, message: string): T {
  if (!entity) throw new NotFoundException(message);
  if (user.role !== "SUPER_ADMIN" && (entity.isTest ?? false) !== (user.isTest ?? false)) {
    throw new NotFoundException(message);
  }
  return entity;
}

/** 创建子资源时校验父级同侧：超管创建的数据属于测试侧，只能挂在测试侧父级下。 */
export function sameSideCreate(parent: { isTest?: boolean }, user: CurrentUser): boolean {
  const isTest = isTestCreator(user);
  if ((parent.isTest ?? false) !== isTest) {
    throw new BadRequestException(isTest ? "测试数据需创建在测试店铺下" : "正式数据不能创建在测试店铺下");
  }
  return isTest;
}

/** 两个实体必须同侧（用于绑定关系，如商品绑到直播间）。 */
export function assertSameSide(a: { isTest?: boolean }, b: { isTest?: boolean }): void {
  if ((a.isTest ?? false) !== (b.isTest ?? false)) throw new BadRequestException("测试数据与正式数据不能混用");
}
