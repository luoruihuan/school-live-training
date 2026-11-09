import type { NextFunction, Request, Response } from "express";

export function allowedOrigin(origin: unknown): boolean {
  if (typeof origin !== "string") return false;
  const configured = (process.env.APP_ORIGIN || "http://127.0.0.1:5173")
    .split(",").map((item) => item.trim()).filter(Boolean);
  return configured.includes(origin);
}

export function csrfProtection(request: Request, response: Response, next: NextFunction): void {
  if (["GET", "HEAD", "OPTIONS"].includes(request.method) || request.path === "/api/webhooks/srs") {
    next();
    return;
  }
  if (allowedOrigin(request.headers.origin) && request.headers["x-school-live-request"] === "1") {
    next();
    return;
  }
  response.status(403).json({ message: "请求来源无效，请从平台页面重新操作" });
}
