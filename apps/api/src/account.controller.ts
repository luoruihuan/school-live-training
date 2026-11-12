import { BadRequestException, Body, Controller, ForbiddenException, Get, NotFoundException, Param, Patch, Post, Query, Req, Res, UploadedFile, UseGuards, UseInterceptors } from "@nestjs/common";
import { FileInterceptor } from "@nestjs/platform-express";
import type { Response } from "express";
import ExcelJS from "exceljs";
import { AuthGuard, type UserRequest } from "./auth.guard.js";
import { hashPassword } from "./auth.service.js";
import { integerField, object, optionalString, stringField } from "./input.js";
import { PrismaService } from "./prisma.service.js";
import { ChatGateway } from "./chat.gateway.js";
import { withUserLock } from "./user-transaction.js";
import { AuditService } from "./audit.service.js";
import { isAdminRole } from "./auth.guard.js";
import { dataScope, isTestCreator, scoped } from "./data-scope.js";

export const IMPORT_MAX_ROWS = 500;
export const BATCH_MAX_USERS = 500;

/** 导入模板自带的示例行（正式导入前可删除；不删除时解析器自动跳过，不会创建账号） */
export const TEMPLATE_EXAMPLE_ROW = { email: "20260001", displayName: "张三", role: "学生", password: "zs123456" } as const;

export type ImportRow = { row: number; email: string; displayName: string; role: "TEACHER" | "STUDENT"; password: string };
export type ImportIssue = { row: number; email: string; reason: string };

/** Excel 行（单元格值数组，已去掉行号列）→ 待创建账号；逐行收集错误便于导入报告回显。 */
export function parseImportRows(rows: (string | number | null | undefined)[][]): { parsed: ImportRow[]; issues: ImportIssue[] } {
  const parsed: ImportRow[] = [];
  const issues: ImportIssue[] = [];
  const seen = new Set<string>();
  rows.forEach((cells, index) => {
    const row = index + 2; // Excel 行号（第 1 行是表头）
    const values = cells.map((cell) => (typeof cell === "string" ? cell.trim() : cell === null || cell === undefined ? "" : String(cell).trim()));
    const email = values[0] ?? "";
    if (!values.some((value) => value !== "")) return; // 整行空白跳过
    if (values[0] === TEMPLATE_EXAMPLE_ROW.email && values[1] === TEMPLATE_EXAMPLE_ROW.displayName) return; // 模板示例行：自动跳过
    if (!email) { issues.push({ row, email: "", reason: "账号（第 1 列）未填写" }); return; }
    if (!/^[a-zA-Z0-9._@-]{2,100}$/.test(email)) { issues.push({ row, email, reason: "账号仅支持字母、数字、点、下划线、@、中划线" }); return; }
    if (seen.has(email.toLowerCase())) { issues.push({ row, email, reason: "与前面行重复" }); return; }
    seen.add(email.toLowerCase());
    const displayName = values[1] || email;
    if (displayName.length > 80) { issues.push({ row, email, reason: "姓名超过 80 字" }); return; }
    const roleText = (values[2] || "学生").toLowerCase();
    const role = roleText === "教师" || roleText === "teacher" ? "TEACHER" : roleText === "学生" || roleText === "student" || roleText === "" ? "STUDENT" : null;
    if (!role) { issues.push({ row, email, reason: "角色只能填“学生”或“教师”" }); return; }
    const password = values[3] || "123456";
    if (password.length < 6 || password.length > 200) { issues.push({ row, email, reason: "初始密码需为 6~200 位" }); return; }
    parsed.push({ row, email: email.toLowerCase(), displayName, role, password });
  });
  return { parsed, issues };
}

function pointModeInput(input: Record<string, unknown>): "ADD" | "DEDUCT" | "SET" {
  const mode = input.mode ?? "ADD";
  if (mode !== "ADD" && mode !== "DEDUCT" && mode !== "SET") throw new BadRequestException("积分操作类型不正确");
  return mode;
}

function pointModeText(mode: "ADD" | "DEDUCT" | "SET"): string {
  return mode === "ADD" ? "增加" : mode === "DEDUCT" ? "扣减" : "设置";
}

/** exceljs 单元格值 → 纯文本（富文本/公式/超链接取可见文本，日期降级为空串）。 */
function cellText(cell: ExcelJS.CellValue): string {
  if (cell === null || cell === undefined) return "";
  if (typeof cell === "object") {
    if (cell instanceof Date) return "";
    if ("richText" in cell) return cell.richText.map((part) => part.text).join("");
    if ("text" in cell) return typeof cell.text === "string" ? cell.text : "";
    if ("result" in cell) return cell.result === null || cell.result === undefined ? "" : String(cell.result);
    return "";
  }
  return String(cell);
}

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
      where: { ...(request.currentUser.role === "SUPER_ADMIN" ? {} : { role: { not: "SUPER_ADMIN" } }), ...dataScope(request.currentUser) ?? {} },
      select: { id: true, email: true, displayName: true, role: true, isTest: true, isActive: true, mustChangePassword: true, pointsBalance: true, createdAt: true },
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
      const users = await tx.$queryRaw<{ role: string; isTest: number }[]>`SELECT role, isTest FROM User WHERE id = ${id} FOR UPDATE`;
      if (!users[0]) throw new NotFoundException("账号不存在");
      if (request.currentUser.role !== "SUPER_ADMIN" && !!(users[0].isTest ?? 0) !== !!(request.currentUser.isTest ?? false)) {
        throw new NotFoundException("账号不存在");
      }
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
      const users = await tx.$queryRaw<{ role: string; isTest: number }[]>`SELECT role, isTest FROM User WHERE id = ${id} FOR UPDATE`;
      if (!users[0]) throw new NotFoundException("账号不存在");
      if (request.currentUser.role !== "SUPER_ADMIN" && !!(users[0].isTest ?? 0) !== !!(request.currentUser.isTest ?? false)) {
        throw new NotFoundException("账号不存在");
      }
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

  /** 单人/批量共用的积分调整核心：幂等 + 行锁 + 余额校验 + 流水。返回调整后余额。 */
  private async adjustPoints(request: UserRequest, userId: string, mode: "ADD" | "DEDUCT" | "SET", points: number, reason: string, requestKey: string): Promise<{ balanceAfter: number }> {
    return withUserLock(this.prisma, userId, async (tx) => {
      const previous = await tx.pointLedger.findUnique({ where: { userId_requestKey: { userId, requestKey } } });
      if (previous) {
        if (previous.actorId !== request.currentUser.id || previous.reason !== reason ||
            (mode === "SET" ? previous.balanceAfter !== points : previous.delta !== (mode === "ADD" ? points : -points))) {
          throw new BadRequestException("该提交标识已用于其他积分操作，请刷新后重试");
        }
        return previous;
      }
      const user = scoped(await tx.user.findUnique({ where: { id: userId } }), request.currentUser, "账号不存在");
      if (isAdminRole(user.role)) throw new BadRequestException("不能调整管理员积分");
      const delta = mode === "ADD" ? points : mode === "DEDUCT" ? -points : points - user.pointsBalance;
      const balanceAfter = user.pointsBalance + delta;
      if (balanceAfter < 0) throw new BadRequestException("积分不足，不能扣减");
      if (balanceAfter > 2_000_000_000) throw new BadRequestException("积分余额超限");
      await tx.user.update({ where: { id: userId }, data: { pointsBalance: balanceAfter } });
      return tx.pointLedger.create({ data: { userId, actorId: request.currentUser.id, delta, balanceAfter, reason, requestKey } });
    });
  }

  @Post(":id/points")
  async topup(@Req() request: UserRequest, @Param("id") id: string, @Body() body: unknown) {
    this.admin(request);
    const input = object(body);
    const mode = pointModeInput(input);
    const points = integerField(input, "points", mode === "SET" ? 0 : 1, mode === "SET" ? 2_000_000_000 : 1_000_000);
    const requestKey = stringField(input, "requestKey", 100);
    if (!/^[a-zA-Z0-9-]{16,100}$/.test(requestKey)) throw new BadRequestException("积分提交标识不正确");
    const reason = optionalString(input, "reason", 100) || (mode === "ADD" ? "管理员发放" : "管理员调整");
    const entry = await this.adjustPoints(request, id, mode, points, reason, requestKey);
    await this.audit.log({ action: "POINTS_ADJUST", userId: id, actorName: request.currentUser.displayName, request, detail: `${request.currentUser.displayName} ${pointModeText(mode)} ${points} 积分（${reason}），余额 ${entry.balanceAfter}` });
    return entry;
  }

  @Post("points-batch")
  async pointsBatch(@Req() request: UserRequest, @Body() body: unknown) {
    this.admin(request);
    const input = object(body);
    const mode = pointModeInput(input);
    const points = integerField(input, "points", mode === "SET" ? 0 : 1, mode === "SET" ? 2_000_000_000 : 1_000_000);
    const requestKey = stringField(input, "requestKey", 100);
    if (!/^[a-zA-Z0-9-]{16,100}$/.test(requestKey)) throw new BadRequestException("积分提交标识不正确");
    const reason = optionalString(input, "reason", 100) || (mode === "ADD" ? "管理员批量发放" : "管理员批量调整");
    const userIds = input.userIds;
    if (!Array.isArray(userIds) || userIds.length < 1 || userIds.length > BATCH_MAX_USERS || userIds.some((id) => typeof id !== "string" || !/^[a-zA-Z0-9-]{10,64}$/.test(id))) {
      throw new BadRequestException(`请选择 1~${BATCH_MAX_USERS} 个账号`);
    }
    const results: ({ userId: string; ok: true; balanceAfter: number } | { userId: string; ok: false; error: string })[] = [];
    for (const userId of [...new Set(userIds)]) {
      // 逐用户独立行锁与提交标识：部分失败可重试，已成功用户幂等跳过
      const perKey = `${requestKey}-${userId}`;
      if (perKey.length > 100) {
        results.push({ userId, ok: false, error: "提交标识过长，请刷新后重试" });
        continue;
      }
      try {
        const entry = await this.adjustPoints(request, userId, mode, points, reason, perKey);
        results.push({ userId, ok: true, balanceAfter: entry.balanceAfter });
      } catch (error) {
        results.push({ userId, ok: false, error: error instanceof BadRequestException || error instanceof NotFoundException || error instanceof ForbiddenException ? error.message : "调整失败，请重试" });
      }
    }
    const succeeded = results.filter((item) => item.ok).length;
    await this.audit.log({ action: "POINTS_ADJUST", actorName: request.currentUser.displayName, request, detail: `${request.currentUser.displayName} 批量${pointModeText(mode)} ${points} 积分 × ${results.length} 人：成功 ${succeeded}、失败 ${results.length - succeeded}（${reason}）` });
    return { results, succeeded, failed: results.length - succeeded };
  }

  @Get("import-template")
  async importTemplate(@Req() request: UserRequest, @Res() response: Response) {
    this.admin(request);
    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet("账号导入");
    sheet.columns = [
      { header: "账号（必填：学号或邮箱，2~100 位字母/数字/._@-）", key: "email", width: 44 },
      { header: "姓名（选填，不填默认同账号）", key: "displayName", width: 26 },
      { header: "角色（填：学生 或 教师，不填默认学生）", key: "role", width: 28 },
      { header: "初始密码（选填，6~200 位，不填默认 123456）", key: "password", width: 34 }
    ];
    sheet.getRow(1).font = { bold: true };
    // 示例行：灰色斜体供参考；正式导入前可删除，不删除也会被自动跳过
    const example = sheet.addRow([TEMPLATE_EXAMPLE_ROW.email, TEMPLATE_EXAMPLE_ROW.displayName, TEMPLATE_EXAMPLE_ROW.role, TEMPLATE_EXAMPLE_ROW.password]);
    example.font = { italic: true, color: { argb: "FF9AA0A6" } };
    example.getCell(1).note = "示例行：仅供填写参考。正式导入前可删除本行；不删除时系统会自动跳过，不会创建该账号。";
    const buffer = await workbook.xlsx.writeBuffer();
    response.status(200);
    response.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    response.setHeader("Content-Disposition", 'attachment; filename="users-import-template.xlsx"');
    response.send(Buffer.from(buffer));
  }

  @Post("import")
  @UseInterceptors(FileInterceptor("file", { limits: { fileSize: 4_000_000 } }))
  async importUsers(@Req() request: UserRequest, @UploadedFile() file: Express.Multer.File | undefined) {
    this.admin(request);
    if (!file?.buffer) throw new BadRequestException("请选择 Excel 文件（.xlsx）");
    if (file.buffer[0] !== 0x50 || file.buffer[1] !== 0x4b) throw new BadRequestException("仅支持 .xlsx 文件，请使用下载的模板填写");
    let workbook: ExcelJS.Workbook;
    try {
      workbook = new ExcelJS.Workbook();
      // exceljs 自带类型声明的 Buffer 与新版 @types/node 泛型冲突，取 load 形参类型断言兼容
      await workbook.xlsx.load(file.buffer as unknown as Parameters<typeof workbook.xlsx.load>[0]);
    } catch {
      throw new BadRequestException("Excel 文件无法解析，请使用下载的模板填写");
    }
    const sheet = workbook.worksheets[0];
    if (!sheet) throw new BadRequestException("Excel 中没有工作表");
    const rows: (string | number | null | undefined)[][] = [];
    sheet.eachRow({ includeEmpty: false }, (row, rowNumber) => {
      if (rowNumber >= 2 && Array.isArray(row.values)) rows.push(row.values.slice(1).map((cell) => cellText(cell)));
    });
    if (!rows.length) throw new BadRequestException("没有可导入的数据行");
    if (rows.length > IMPORT_MAX_ROWS) throw new BadRequestException(`单次最多导入 ${IMPORT_MAX_ROWS} 个账号，请分批上传`);
    const { parsed, issues } = parseImportRows(rows);
    const failed: ImportIssue[] = [...issues];
    const created: string[] = [];
    const side = isTestCreator(request.currentUser);
    for (const item of parsed) {
      try {
        const exists = await this.prisma.user.findUnique({ where: { email: item.email }, select: { id: true } });
        if (exists) { failed.push({ row: item.row, email: item.email, reason: "该账号已存在" }); continue; }
        await this.prisma.user.create({
          data: { email: item.email, displayName: item.displayName, passwordHash: await hashPassword(item.password), role: item.role, isTest: side, mustChangePassword: true },
          select: { id: true }
        });
        created.push(item.email);
      } catch {
        failed.push({ row: item.row, email: item.email, reason: "创建失败（该账号可能刚被其他管理员创建）" });
      }
    }
    await this.audit.log({ action: "USER_CREATED", actorName: request.currentUser.displayName, request, detail: `${request.currentUser.displayName} 批量导入 ${created.length} 个账号（失败 ${failed.length} 个）` });
    return { created: created.length, failed };
  }

  @Get(":id/points")
  async pointHistory(@Req() request: UserRequest, @Param("id") id: string, @Query() query: Record<string, unknown>) {
    this.admin(request);
    scoped(await this.prisma.user.findUnique({ where: { id }, select: { id: true, isTest: true } }), request.currentUser, "账号不存在");
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
