import { NotFoundException } from "@nestjs/common";
import type { CurrentUser } from "./auth.service.js";

export function visibleRoom<T extends { status: string; isTest?: boolean }>(room: T | null, user: CurrentUser & { isTest?: boolean }): T {
  if (!room || (user.role === "STUDENT" && room.status === "DRAFT")) {
    throw new NotFoundException("直播间不存在");
  }
  // 测试数据与正式数据两侧互不可见；超级管理员可看全部。
  if (user.role !== "SUPER_ADMIN" && (room.isTest ?? false) !== (user.isTest ?? false)) {
    throw new NotFoundException("直播间不存在");
  }
  return room;
}
