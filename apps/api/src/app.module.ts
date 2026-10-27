import { Module } from "@nestjs/common";
import { AuthController } from "./auth.controller.js";
import { AuthService } from "./auth.service.js";
import { AuthGuard } from "./auth.guard.js";
import { BusinessController } from "./business.controller.js";
import { CommerceController } from "./commerce.controller.js";
import { ChatGateway } from "./chat.gateway.js";
import { ChatController } from "./chat.controller.js";
import { CloudWebhookController } from "./cloud-webhook.controller.js";
import { RecordingController } from "./recording.controller.js";
import { CosService } from "./cos.service.js";
import { UploadController } from "./upload.controller.js";
import { PrismaService } from "./prisma.service.js";
import { UsageController } from "./usage.controller.js";
import { AccountController } from "./account.controller.js";
import { HealthController } from "./health.controller.js";

@Module({
  controllers: [AuthController, BusinessController, CommerceController, ChatController, CloudWebhookController, RecordingController, UploadController, UsageController, AccountController, HealthController],
  providers: [PrismaService, AuthService, AuthGuard, ChatGateway, CosService]
})
export class AppModule {}
