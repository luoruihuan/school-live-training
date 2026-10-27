import { BadRequestException, Body, Controller, ForbiddenException, Get, Post, Req, UseGuards } from "@nestjs/common";
import { AuthGuard, requireStaff, type UserRequest } from "./auth.guard.js";
import { integerField, object, stringField } from "./input.js";
import { PrismaService } from "./prisma.service.js";

const THRESHOLDS = [50, 80, 95, 100] as const;

function parseDate(value: string): Date {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new BadRequestException("日期格式须为 YYYY-MM-DD");
  const date = new Date(`${value}T00:00:00.000Z`);
  if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== value) {
    throw new BadRequestException("日期无效");
  }
  return date;
}

function addYear(date: Date, years: number): Date {
  const year = date.getUTCFullYear() + years;
  const month = date.getUTCMonth();
  const lastDay = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  return new Date(Date.UTC(year, month, Math.min(date.getUTCDate(), lastDay)));
}

function chinaToday(): string {
  return new Date(Date.now() + 8 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

@Controller("usage")
@UseGuards(AuthGuard)
export class UsageController {
  constructor(private readonly prisma: PrismaService) {}

  @Get("summary")
  async summary(@Req() request: UserRequest) {
    requireStaff(request.currentUser);
    const [quota, days] = await Promise.all([
      this.prisma.serviceQuota.findUnique({ where: { id: 1 } }),
      this.prisma.usageDaily.findMany({ orderBy: { date: "desc" } })
    ]);
    if (!quota) return { configured: false, years: [], recentDays: days.slice(0, 30), unallocatedMb: 0 };

    const start = parseDate(quota.startDate);
    const boundaries = [start, addYear(start, 1), addYear(start, 2)];
    const years = [0, 1].map((index) => {
      const from = boundaries[index].toISOString().slice(0, 10);
      const to = boundaries[index + 1].toISOString().slice(0, 10);
      const usedMb = days.reduce((sum, day) => sum + (day.date >= from && day.date < to ? day.billedMb : 0), 0);
      const quotaMb = quota.annualGb * 1000;
      const rawPercent = usedMb / quotaMb * 100;
      const percent = Math.round(rawPercent * 100) / 100;
      return {
        year: index + 1, from, toExclusive: to, usedGb: Math.round(usedMb / 1000 * 1000) / 1000,
        quotaGb: quota.annualGb, percent, reachedThresholds: THRESHOLDS.filter((threshold) => rawPercent >= threshold),
        remainingGb: Math.max(0, Math.round((quotaMb - usedMb) / 1000 * 1000) / 1000)
      };
    });
    const unallocatedMb = days.reduce((sum, day) => sum + (
      day.date < years[0].from || day.date >= years[1].toExclusive ? day.billedMb : 0
    ), 0);
    return { configured: true, startDate: quota.startDate, years, recentDays: days.slice(0, 30), unallocatedMb };
  }

  @Post("quota")
  async setQuota(@Req() request: UserRequest, @Body() body: unknown) {
    if (request.currentUser.role !== "ADMIN") throw new ForbiddenException("仅管理员可设置服务起始日");
    const input = object(body);
    const startDate = stringField(input, "startDate", 10);
    parseDate(startDate);
    if (startDate > chinaToday()) throw new BadRequestException("服务起始日不能晚于今天");
    const annualGb = integerField(input, "annualGb", 1, 1_000_000);
    const count = await this.prisma.usageDaily.count();
    if (count > 0) throw new BadRequestException("已有流量记录，不能重设服务周期或额度");
    return this.prisma.serviceQuota.upsert({
      where: { id: 1 }, update: { startDate, annualGb }, create: { id: 1, startDate, annualGb }
    });
  }

  @Post("daily")
  async upsertDay(@Req() request: UserRequest, @Body() body: unknown) {
    if (request.currentUser.role !== "ADMIN") throw new ForbiddenException("仅管理员可录入计费流量");
    const input = object(body);
    const date = stringField(input, "date", 10);
    parseDate(date);
    if (date > chinaToday()) throw new BadRequestException("不能录入未来日期");
    const quota = await this.prisma.serviceQuota.findUnique({ where: { id: 1 } });
    if (!quota) throw new BadRequestException("请先设置服务起始日和年度额度");
    const endDate = addYear(parseDate(quota.startDate), 2).toISOString().slice(0, 10);
    if (date < quota.startDate || date >= endDate) throw new BadRequestException("日期不在两年服务期内");
    const billedMb = input.billedMb;
    if (typeof billedMb !== "number" || !Number.isFinite(billedMb) || billedMb < 0 || billedMb > 1_000_000_000 || Math.abs(Math.round(billedMb * 1000) - billedMb * 1000) > 1e-7) {
      throw new BadRequestException("计费流量须为非负数，最多保留三位小数（MB）");
    }
    return this.prisma.usageDaily.upsert({
      where: { date }, update: { billedMb, source: "MANUAL" }, create: { date, billedMb, source: "MANUAL" }
    });
  }
}
