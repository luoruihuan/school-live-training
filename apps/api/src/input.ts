import { BadRequestException } from "@nestjs/common";

export function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new BadRequestException("请求内容必须是对象");
  }
  return value as Record<string, unknown>;
}

export function stringField(input: Record<string, unknown>, key: string, max = 120): string {
  const value = input[key];
  if (typeof value !== "string" || !value.trim() || value.length > max) {
    throw new BadRequestException(`${key} 格式不正确`);
  }
  return value.trim();
}

export function optionalString(input: Record<string, unknown>, key: string, max = 1000): string | undefined {
  if (input[key] === undefined) return undefined;
  if (typeof input[key] !== "string" || input[key].length > max) {
    throw new BadRequestException(`${key} 格式不正确`);
  }
  return input[key].trim();
}

export function integerField(input: Record<string, unknown>, key: string, min: number, max: number): number {
  const value = input[key];
  if (!Number.isInteger(value) || (value as number) < min || (value as number) > max) {
    throw new BadRequestException(`${key} 格式不正确`);
  }
  return value as number;
}
