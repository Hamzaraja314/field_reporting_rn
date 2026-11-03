import { ValidationPipe } from "@nestjs/common";
import { INestApplication } from "@nestjs/common";
import { DocumentBuilder, SwaggerModule } from "@nestjs/swagger";

export function configureApp(app: INestApplication): void {
  const server = app.getHttpServer();
  server.requestTimeout = 5 * 60 * 1000;
  server.headersTimeout = 60 * 1000;
  server.timeout = 5 * 60 * 1000;

  app.setGlobalPrefix("api/v1");
  app.useGlobalPipes(
    new ValidationPipe({
      transform: true,
      whitelist: true,
      forbidNonWhitelisted: true,
    })
  );

  const swaggerConfig = new DocumentBuilder()
    .setTitle("Field Reporting API")
    .setDescription("API for creating and retrieving field reports.")
    .setVersion("1.0")
    .build();
  const document = SwaggerModule.createDocument(app, swaggerConfig);
  SwaggerModule.setup("docs", app, document, { useGlobalPrefix: true });
}
