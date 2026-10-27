export type UsageDayForQuota = { date: string; billedMb: number };

type QuotaState = {
  usedMb: number;
  quotaMb: number;
  percent: number;
  blocked: boolean;
  reason: string;
};

function addYear(value: string, years: number): string {
  const date = new Date(`${value}T00:00:00.000Z`);
  const year = date.getUTCFullYear() + years;
  const month = date.getUTCMonth();
  const day = Math.min(date.getUTCDate(), new Date(Date.UTC(year, month + 1, 0)).getUTCDate());
  return new Date(Date.UTC(year, month, day)).toISOString().slice(0, 10);
}

export function quotaState(
  startDate: string,
  annualGb: number,
  days: readonly UsageDayForQuota[],
  today: string
): QuotaState {
  const endDate = addYear(startDate, 2);
  if (today < startDate || today >= endDate) {
    return { usedMb: 0, quotaMb: annualGb * 1000, percent: 100, blocked: true, reason: "当前日期不在两年服务期内" };
  }

  const yearStart = today < addYear(startDate, 1) ? startDate : addYear(startDate, 1);
  const yearEnd = today < addYear(startDate, 1) ? addYear(startDate, 1) : endDate;
  const usedMb = days.reduce((sum, day) => sum + (day.date >= yearStart && day.date < yearEnd ? day.billedMb : 0), 0);
  const quotaMb = annualGb * 1000;
  const percent = Math.round(usedMb / quotaMb * 10000) / 100;
  const blocked = usedMb >= quotaMb;
  return {
    usedMb,
    quotaMb,
    percent,
    blocked,
    reason: blocked ? `本服务年度已达到 ${annualGb.toLocaleString("zh-CN")} GB 额度` : ""
  };
}
