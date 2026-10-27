import { Body, Controller, Get, Post, Req, Res } from "@nestjs/common";
import type { Request, Response } from "express";
import { AuthService } from "./auth.service.js";
import { object, stringField } from "./input.js";

function cookieToken(request: { headers: { cookie?: string } }): string | undefined {
  const item = request.headers.cookie?.split(";").map((part) => part.trim()).find((part) => part.startsWith("sid="));
  if (!item) return undefined;
  try { return decodeURIComponent(item.slice(4)); }
  catch { return undefined; }
}

@Controller("auth")
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  @Post("login")
  async login(@Body() body: unknown, @Res({ passthrough: true }) response: Response) {
    const input = object(body);
    const result = await this.auth.login(stringField(input, "email", 254), stringField(input, "password", 200));
    response.cookie("sid", result.token, {
      httpOnly: true,
      secure: process.env.COOKIE_SECURE === "true",
      sameSite: "strict",
      path: "/",
      maxAge: 7 * 24 * 60 * 60 * 1000
    });
    return result.user;
  }

  @Get("me")
  me(@Req() request: Request) {
    return this.auth.userForToken(cookieToken(request));
  }

  @Post("change-password")
  async changePassword(@Req() request: Request, @Body() body: unknown, @Res({ passthrough: true }) response: Response) {
    const input = object(body);
    await this.auth.changePassword(cookieToken(request), stringField(input, "currentPassword", 200), stringField(input, "newPassword", 200));
    response.clearCookie("sid", { path: "/" });
    return { ok: true };
  }

  @Post("logout")
  async logout(@Req() request: Request, @Res({ passthrough: true }) response: Response) {
    await this.auth.logout(cookieToken(request));
    response.clearCookie("sid", { path: "/" });
    return { ok: true };
  }
}

export { cookieToken };
