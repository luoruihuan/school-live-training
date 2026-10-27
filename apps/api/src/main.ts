import "reflect-metadata";
import "dotenv/config";
import { NestFactory } from "@nestjs/core";
import { AppModule } from "./app.module.js";
import { csrfProtection } from "./request-security.js";

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule);
  app.use(csrfProtection);
  app.setGlobalPrefix("api");
  app.enableShutdownHooks();
  await app.listen(Number(process.env.PORT ?? 3000), process.env.HOST ?? "127.0.0.1");
}

void bootstrap();
