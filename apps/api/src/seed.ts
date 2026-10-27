import "dotenv/config";
import { PrismaMariaDb } from "@prisma/adapter-mariadb";
import { PrismaClient } from "./generated/prisma/client.js";
import { hashPassword } from "./auth.service.js";

const email = process.env.BOOTSTRAP_ADMIN_EMAIL;
const password = process.env.BOOTSTRAP_ADMIN_PASSWORD;
const databaseUrl = process.env.DATABASE_URL;
if (!email || !password || !databaseUrl || password.length < 16 || password.includes("replace-with")) {
  throw new Error("请设置 DATABASE_URL、管理员邮箱及至少 16 位随机密码");
}

const prisma = new PrismaClient({ adapter: new PrismaMariaDb(databaseUrl) });
try {
  await prisma.user.upsert({
    where: { email: email.toLowerCase() },
    update: {},
    create: {
      email: email.toLowerCase(),
      displayName: "系统管理员",
      passwordHash: await hashPassword(password),
      role: "ADMIN"
    }
  });
  process.stdout.write("管理员账号已创建或已存在\n");
} finally {
  await prisma.$disconnect();
}
