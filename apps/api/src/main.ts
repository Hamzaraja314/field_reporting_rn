import "reflect-metadata";
import { config } from "dotenv";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { NestFactory } from "@nestjs/core";
import { AppModule } from "./app.module";
import { configureApp } from "./configure-app";

const envPaths = [
  resolve(process.cwd(), "apps", "api", ".env"),
  resolve(process.cwd(), ".env"),
  resolve(__dirname, "..", ".env"),
];
const envPath = envPaths.find(existsSync);
if (envPath) {
  config({ path: envPath });
}

async function bootstrap(): Promise<void> {
  if (!process.env.DATABASE_URL) {
    throw new Error(
      "DATABASE_URL is required. Set it in apps/api/.env or the process environment."
    );
  }

  const app = await NestFactory.create(AppModule);
  configureApp(app);
  await app.listen(Number(process.env.PORT ?? 3000), "0.0.0.0");
}

void bootstrap();
