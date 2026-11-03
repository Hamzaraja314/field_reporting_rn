import { Module } from "@nestjs/common";
import { PrismaModule } from "./prisma/prisma.module";
import { ReportsModule } from "./reports/reports.module";

@Module({
  imports: [PrismaModule, ReportsModule],
})
export class AppModule {}
