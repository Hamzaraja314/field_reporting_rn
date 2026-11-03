import { MiddlewareConsumer, Module, NestModule } from "@nestjs/common";
import { ReportStorageService } from "./report-storage.service";
import { ReportFilesInterceptor } from "./report-files.interceptor";
import { ReportsController } from "./reports.controller";
import { ReportsService } from "./reports.service";
import { DevFailureMiddleware } from "./dev-failure.middleware";

@Module({
  controllers: [ReportsController],
  providers: [
    ReportStorageService,
    ReportFilesInterceptor,
    ReportsService,
    DevFailureMiddleware,
  ],
})
export class ReportsModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(DevFailureMiddleware).forRoutes(ReportsController);
  }
}
