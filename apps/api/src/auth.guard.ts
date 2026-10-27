import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from "@nestjs/common";
import type { Request } from "express";
import { AuthService, type CurrentUser } from "./auth.service.js";
import { cookieToken } from "./auth.controller.js";

export type UserRequest = Request & { currentUser: CurrentUser };

@Injectable()
export class AuthGuard implements CanActivate {
  constructor(private readonly auth: AuthService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<UserRequest>();
    request.currentUser = await this.auth.userForToken(cookieToken(request));
    if (request.currentUser.mustChangePassword) throw new ForbiddenException("请先修改初始密码");
    return true;
  }
}

export function requireStaff(user: CurrentUser): void {
  if (user.role !== "ADMIN" && user.role !== "TEACHER") {
    throw new ForbiddenException("仅教师或管理员可操作");
  }
}
