import { NotFoundException } from "@nestjs/common";

export function visibleRoom<T extends { status: string }>(room: T | null, role: string): T {
  if (!room || (role === "STUDENT" && room.status === "DRAFT")) {
    throw new NotFoundException("直播间不存在");
  }
  return room;
}
