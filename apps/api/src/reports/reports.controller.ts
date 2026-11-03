import {
  BadRequestException,
  Body,
  Controller,
  DefaultValuePipe,
  Get,
  Param,
  ParseIntPipe,
  ParseUUIDPipe,
  Post,
  Query,
  Req,
  Res,
  UseInterceptors,
} from "@nestjs/common";
import {
  ApiBody,
  ApiConsumes,
  ApiCreatedResponse,
  ApiHeader,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiQuery,
  ApiResponse,
  ApiTags,
} from "@nestjs/swagger";
import { isUUID } from "class-validator";
import { Request, Response } from "express";
import { CreateReportDto } from "./create-report.dto";
import { ReportFilesInterceptor } from "./report-files.interceptor";
import { ReportsService } from "./reports.service";
import { ReportResponseDto } from "./report-response.dto";

type UploadRequest = Request & {
  files?: Express.Multer.File[];
};

@ApiTags("reports")
@Controller("reports")
export class ReportsController {
  constructor(private readonly reports: ReportsService) {}

  @Post()
  @UseInterceptors(ReportFilesInterceptor)
  @ApiOperation({ summary: "Create a report with image attachments" })
  @ApiConsumes("multipart/form-data")
  @ApiHeader({
    name: "Idempotency-Key",
    required: true,
    description: "Stable UUID reused for retries of the same request.",
    schema: { type: "string", format: "uuid" },
  })
  @ApiBody({
    schema: {
      type: "object",
      required: ["description", "images"],
      properties: {
        description: { type: "string", minLength: 1 },
        images: {
          type: "array",
          items: { type: "string", format: "binary" },
          minItems: 1,
          maxItems: 5,
        },
      },
    },
  })
  @ApiCreatedResponse({ type: ReportResponseDto })
  @ApiResponse({
    status: 409,
    description: "Idempotency key payload conflict.",
  })
  @ApiResponse({ status: 413, description: "An image exceeds 5 MiB." })
  @ApiResponse({ status: 415, description: "Unsupported image type." })
  async create(
    @Req() request: UploadRequest,
    @Body() body: CreateReportDto,
    @Res({ passthrough: true }) response: Response
  ) {
    const idempotencyKeys = (request.header("idempotency-key") ?? "")
      .split(",")
      .map((key) => key.trim())
      .filter(Boolean);
    const idempotencyKey = idempotencyKeys[0]?.toLowerCase();
    if (
      !idempotencyKey ||
      idempotencyKeys.some((key) => key.toLowerCase() !== idempotencyKey) ||
      !isUUID(idempotencyKey)
    ) {
      throw new BadRequestException("Idempotency-Key must be a UUID.");
    }
    const report = await this.reports.create(
      idempotencyKey,
      body.description,
      request.files ?? []
    );

    if (
      process.env.NODE_ENV !== "production" &&
      process.env.FAILURE_INJECTION_ENABLED === "true" &&
      request.header("x-dev-failure") === "after-commit-drop"
    ) {
      response.socket?.destroy();
    }
    return report;
  }

  @Get()
  @ApiOperation({ summary: "List persisted reports" })
  @ApiQuery({
    name: "limit",
    required: false,
    schema: { type: "integer", minimum: 1, maximum: 100 },
  })
  @ApiQuery({
    name: "offset",
    required: false,
    schema: { type: "integer", minimum: 0 },
  })
  @ApiOkResponse({
    schema: {
      type: "object",
      required: ["data", "nextOffset"],
      properties: {
        data: {
          type: "array",
          items: { $ref: "#/components/schemas/ReportResponseDto" },
        },
        nextOffset: { type: "integer", nullable: true },
      },
    },
  })
  list(
    @Query("limit", new DefaultValuePipe(20), ParseIntPipe) limit: number,
    @Query("offset", new DefaultValuePipe(0), ParseIntPipe) offset?: number
  ) {
    return this.reports.list(limit, offset);
  }

  @Get(":id")
  @ApiOperation({ summary: "Retrieve one report" })
  @ApiParam({ name: "id", format: "uuid" })
  @ApiOkResponse({ type: ReportResponseDto })
  @ApiNotFoundResponse({ description: "Report not found." })
  getById(@Param("id", new ParseUUIDPipe({ version: "4" })) id: string) {
    return this.reports.getById(id);
  }

  @Get(":reportId/images/:imageId")
  @ApiOperation({ summary: "Retrieve one report image" })
  @ApiParam({ name: "reportId", format: "uuid" })
  @ApiParam({ name: "imageId", format: "uuid" })
  @ApiOkResponse({
    description: "Image bytes with the stored MIME type.",
    content: {
      "image/jpeg": { schema: { type: "string", format: "binary" } },
      "image/png": { schema: { type: "string", format: "binary" } },
      "image/webp": { schema: { type: "string", format: "binary" } },
    },
  })
  @ApiNotFoundResponse({ description: "Report image not found." })
  async getImage(
    @Param("reportId", new ParseUUIDPipe({ version: "4" })) reportId: string,
    @Param("imageId", new ParseUUIDPipe({ version: "4" })) imageId: string,
    @Res() response: Response
  ): Promise<void> {
    const image = await this.reports.getImage(reportId, imageId);
    response.setHeader("Content-Type", image.mimeType);
    response.setHeader("Content-Length", image.sizeBytes);
    response.setHeader("X-Content-Type-Options", "nosniff");
    await new Promise<void>((resolve, reject) => {
      response.sendFile(image.path, (error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve();
      });
    });
  }
}
