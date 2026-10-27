import { Injectable, OnModuleDestroy } from "@nestjs/common";
import { PrismaMariaDb } from "@prisma/adapter-mariadb";
import { PrismaClient } from "./generated/prisma/client.js";

@Injectable()
export class PrismaService extends PrismaClient implements OnModuleDestroy {
  constructor() {
    const connectionString = process.env.DATABASE_URL;
    if (!connectionString) throw new Error("DATABASE_URL is required");
    super({ adapter: new PrismaMariaDb(connectionString) });
  }

  async onModuleDestroy(): Promise<void> {
    await this.$disconnect();
  }
}
