import { BadRequestException, Controller, Post, Req, UploadedFile, UseGuards, UseInterceptors } from "@nestjs/common";
import { FileInterceptor } from "@nestjs/platform-express";
import { AuthGuard, requireStaff, type UserRequest } from "./auth.guard.js";
import { StorageService } from "./storage.service.js";

function detectedMime(buffer: Buffer): "image/jpeg" | "image/png" | "image/webp" | null {
  if (buffer.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff]))) return "image/jpeg";
  if (buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "image/png";
  if (buffer.toString("ascii", 0, 4) === "RIFF" && buffer.toString("ascii", 8, 12) === "WEBP") return "image/webp";
  return null;
}

@Controller("uploads")
@UseGuards(AuthGuard)
export class UploadController {
  constructor(private readonly storage: StorageService) {}

  @Post("image")
  @UseInterceptors(FileInterceptor("file", { limits: { fileSize: 3_000_000 } }))
  async image(@Req() request: UserRequest, @UploadedFile() file: Express.Multer.File | undefined) {
    requireStaff(request.currentUser);
    if (!file?.buffer) throw new BadRequestException("请选择图片文件");
    const mimeType = detectedMime(file.buffer);
    if (!mimeType) throw new BadRequestException("仅支持 JPEG、PNG、WebP 图片");
    return { imageKey: await this.storage.uploadImage(file.buffer, mimeType) };
  }
}
