import "dotenv/config";
import mysql from "mysql2/promise";
import { spawnSync } from "node:child_process";

const raw = process.env.DATABASE_URL;
if (!raw) throw new Error("DATABASE_URL is required");
if (!process.env.BOOTSTRAP_ADMIN_EMAIL || !process.env.BOOTSTRAP_ADMIN_PASSWORD ||
  process.env.BOOTSTRAP_ADMIN_PASSWORD.length < 16 || process.env.BOOTSTRAP_ADMIN_PASSWORD.includes("replace-with")) {
  throw new Error("请先设置管理员邮箱和至少 16 位随机密码");
}
const url = new URL(raw);
const database = decodeURIComponent(url.pathname.slice(1));
const connection = await mysql.createConnection({
  host: url.hostname,
  port: Number(url.port) || 3306,
  user: decodeURIComponent(url.username),
  password: decodeURIComponent(url.password),
  database
});

let empty;
try {
  const [rows] = await connection.execute(
    "SELECT COUNT(*) AS tableCount FROM information_schema.TABLES WHERE TABLE_SCHEMA = ?",
    [database]
  );
  empty = rows[0].tableCount === 0;
} finally {
  await connection.end();
}

const args = empty ? ["prisma", "db", "push"] : ["prisma", "migrate", "diff", "--from-config-datasource", "--to-schema", "prisma/schema.prisma", "--exit-code"];
const result = spawnSync("npx", args, { stdio: "inherit" });
if (result.status !== 0) {
  throw new Error(empty ? "空库初始化失败" : "现有数据库结构与积分版模型不一致；请先备份并制定迁移方案，部署已停止");
}
const seed = spawnSync("npx", ["tsx", "src/seed.ts"], { stdio: "inherit" });
if (seed.status !== 0) throw new Error("管理员初始化失败");
