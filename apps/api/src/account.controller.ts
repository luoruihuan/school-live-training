import { BadRequestException, Body, Controller, ForbiddenException, Get, NotFoundException, Param, Patch, Post, Query, Req, UseGuards } from "@nestjs/common";
import { AuthGuard, type UserRequest } from "./auth.guard.js";
import { hashPassword } from "./auth.service.js";
import { integerField, object, optionalString, stringField } from "./input.js";
import { PrismaService } from "./prisma.service.js";
import { ChatGateway } from "./chat.gateway.js";
import { withUserLock } from "./user-transaction.js";
import { AuditService } from "./audit.service.js";
import { isAdminRole } from "./auth.guard.js";

@Controller("users")
@UseGuards(AuthGuard)
export class AccountController {
  constructor(private readonly prisma: PrismaService, private readonly chat: ChatGateway, private readonly audit: AuditService) {}

  private admin(request: UserRequest) {
    if (!isAdminRole(request.currentUser.role)) throw new ForbiddenException("仅管理员可管理账号");
  }

  @Get()
  list(@Req() request: UserRequest) {
    this.admin(request);
    return this.prisma.user.findMany({
      where: request.currentUser.role === "SUPER_ADMIN" ? {} : { role: { not: "SUPER_ADMIN" } },
      select: { id: true, email: true, displayName: true, role: true, isActive: true, mustChangePassword: true, pointsBalance: true, createdAt: true },
      orderBy: { createdAt: "desc" }
    });
  }

  @Patch(":id")
  async update(@Req() request: UserRequest, @Param("id") id: string, @Body() body: unknown) {
    this.admin(request);
    const input = object(body);
    if (typeof input.isActive !== "boolean") throw new BadRequestException("账号状态不正确");
    if (id === request.currentUser.id) throw new BadRequestException("不能停用当前管理员账号");
    const isActive = input.isActive;
    const result = await this.prisma.$transaction(async (tx) => {
      const users = await tx.$queryRaw<{ role: string }[]>`SELECT role FROM User WHERE id = ${id} FOR UPDATE`;
      if (!users[0]) throw new NotFoundException("账号不存在");
      if (users[0].role === "SUPER_ADMIN" || (users[0].role === "ADMIN" && request.currentUser.role !== "SUPER_ADMIN")) {
        throw new BadRequestException("此入口仅管理教师和学生账号");
      }
      await tx.user.update({ where: { id }, data: { isActive } });
      await tx.session.deleteMany({ where: { userId: id } });
      return { ok: true };
    });
    this.chat.disconnectUser(id);
    await this.audit.log({ action: isActive ? "USER_ENABLED" : "USER_DISABLED", userId: id, actorName: request.currentUser.displayName, request, detail: `${request.currentUser.displayName} ${isActive ? "启用" : "停用"}了账号 ${id.slice(-8).toUpperCase()}` });
    return result;
  }

  @Post(":id/password")
  async reset(@Req() request: UserRequest, @Param("id") id: string, @Body() body: unknown) {
    this.admin(request);
    const password = stringField(object(body), "password", 200);
    if (password.length < 6) throw new BadRequestException("密码至少 6 位");
    const passwordHash = await hashPassword(password);
    const result = await this.prisma.$transaction(async (tx) => {
      const users = await tx.$queryRaw<{ role: string }[]>`SELECT role FROM User WHERE id = ${id} FOR UPDATE`;
      if (!users[0]) throw new NotFoundException("账号不存在");
      if (users[0].role === "SUPER_ADMIN" || (users[0].role === "ADMIN" && request.currentUser.role !== "SUPER_ADMIN")) {
        throw new BadRequestException("此入口仅管理教师和学生账号");
      }
      await tx.user.update({ where: { id }, data: { passwordHash, mustChangePassword: true } });
      await tx.session.deleteMany({ where: { userId: id } });
      return { ok: true };
    });
    this.chat.disconnectUser(id);
    await this.audit.log({ action: "PASSWORD_RESET", userId: id, actorName: request.currentUser.displayName, request, detail: `${request.currentUser.displayName} 重置了账号 ${id.slice(-8).toUpperCase()} 的密码` });
    return result;
  }

  @Post(":id/points")
  async topup(@Req() request: UserRequest, @Param("id") id: string, @Body() body: unknown) {
    this.admin(request);
    const input = object(body);
    const mode = input.mode ?? "ADD";
    if (mode !== "ADD" && mode !== "DEDUCT" && mode !== "SET") throw new BadRequestException("积分操作类型不正确");
    const points = integerField(input, "points", mode === "SET" ? 0 : 1, mode === "SET" ? 2_000_000_000 : 1_000_000);
    const requestKey = stringField(input, "requestKey", 100);
    if (!/^[a-zA-Z0-9-]{16,100}$/.test(requestKey)) throw new BadRequestException("积分提交标识不正确");
    const reason = optionalString(input, "reason", 100) || (mode === "ADD" ? "管理员发放" : "管理员调整");
    return withUserLock(this.prisma, id, async (tx) => {
      const previous = await tx.pointLedger.findUnique({ where: { userId_requestKey: { userId: id, requestKey } } });
      if (previous) {
        if (previous.actorId !== request.currentUser.id || previous.reason !== reason ||
            (mode === "SET" ? previous.balanceAfter !== points : previous.delta !== (mode === "ADD" ? points : -points))) {
          throw new BadRequestException("该提交标识已用于其他积分操作，请刷新后重试");
        }
        return previous;
      }
      const user = await tx.user.findUniqueOrThrow({ where: { id } });
      if (isAdminRole(user.role)) throw new BadRequestException("不能调整管理员积分");
      const delta = mode === "ADD" ? points : mode === "DEDUCT" ? -points : points - user.pointsBalance;
      const balanceAfter = user.pointsBalance + delta;
      if (balanceAfter < 0) throw new BadRequestException("积分不足，不能扣减");
      if (balanceAfter > 2_000_000_000) throw new BadRequestException("积分余额超限");
      await tx.user.update({ where: { id }, data: { pointsBalance: balanceAfter } });
      await this.audit.log({ action: "POINTS_ADJUST", userId: id, actorName: request.currentUser.displayName, request, detail: `${request.currentUser.displayName} ${mode === "ADD" ? "增加" : mode === "DEDUCT" ? "扣减" : "设置"} ${points} 积分（${reason}），余额 ${balanceAfter}` });
      return tx.pointLedger.create({ data: { userId: id, actorId: request.currentUser.id, delta, balanceAfter, reason, requestKey } });
    });
  }

  @Get(":id/points")
  async pointHistory(@Req() request: UserRequest, @Param("id") id: string, @Query() query: Record<string, unknown>) {
    this.admin(request);
    const page = query.page === undefined ? 1 : Number(query.page);
    if (!Number.isSafeInteger(page) || page < 1 || page > 100_000) throw new BadRequestException("页码不正确");
    const where = { userId: id };
    const [items, total] = await this.prisma.$transaction([
      this.prisma.pointLedger.findMany({ where, include: { actor: { select: { displayName: true } } }, orderBy: { createdAt: "desc" }, skip: (page - 1) * 20, take: 20 }),
      this.prisma.pointLedger.count({ where })
    ]);
    return { items, total, page, pageSize: 20 };
  }
}
