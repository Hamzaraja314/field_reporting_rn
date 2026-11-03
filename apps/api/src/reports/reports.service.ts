import {
  BadRequestException,
  ConflictException,
  Injectable,
  InternalServerErrorException,
  Logger,
  NotFoundException,
} from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import { PrismaService } from "../prisma/prisma.service";
import type {
  ReportListResponse,
  ReportResponse,
} from "@field-reporting/types";
import { ReportStorageService, StagedImage } from "./report-storage.service";
import { toReportResponse } from "./report-response.dto";

const reportInclude = {
  images: { orderBy: { orderIndex: "asc" as const } },
};

@Injectable()
export class ReportsService {
  private readonly logger = new Logger(ReportsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: ReportStorageService
  ) {}

  async create(
    idempotencyKey: string,
    description: string,
    files: Express.Multer.File[]
  ): Promise<ReportResponse> {
    const normalizedDescription = description.trim();
    if (!normalizedDescription) {
      throw new BadRequestException("Description must not be blank.");
    }
    if (files.length < 1 || files.length > 5) {
      throw new BadRequestException(
        "A report must include one to five images."
      );
    }
    if (files.some((file) => file.fieldname !== "images")) {
      throw new BadRequestException('Image files must use the "images" field.');
    }

    const images: StagedImage[] = [];
    for (const file of files) {
      images.push(await this.storage.inspect(file));
    }
    const fingerprint = createHash("sha256")
      .update(
        JSON.stringify({
          description: normalizedDescription,
          images: images.map(({ sha256 }) => sha256),
        })
      )
      .digest("hex");

    const existing = await this.findByIdempotencyKey(idempotencyKey);
    if (existing) {
      this.assertMatchingFingerprint(existing.fingerprint, fingerprint);
      return toReportResponse(existing);
    }

    const finalizedKeys: string[] = [];
    let report: Prisma.ReportGetPayload<{ include: typeof reportInclude }>;
    try {
      const imageRecords = [];
      for (let orderIndex = 0; orderIndex < images.length; orderIndex += 1) {
        const image = images[orderIndex];
        const storageKey = await this.storage.finalize(image);
        finalizedKeys.push(storageKey);
        imageRecords.push({
          storageKey,
          mimeType: image.mimeType,
          sizeBytes: image.sizeBytes,
          orderIndex,
        });
      }

      report = await this.prisma.report.create({
        data: {
          idempotencyKey,
          fingerprint,
          description: normalizedDescription,
          images: { create: imageRecords },
        },
        include: reportInclude,
      });
    } catch (error) {
      if (this.isIdempotencyConflict(error)) {
        let concurrentReport;
        try {
          concurrentReport = await this.findByIdempotencyKey(idempotencyKey);
        } catch (readError) {
          await this.removeFinalizedOrThrow(finalizedKeys, readError);
          throw readError;
        }
        if (concurrentReport) {
          await this.removeFinalizedOrThrow(finalizedKeys, error);
          this.assertMatchingFingerprint(
            concurrentReport.fingerprint,
            fingerprint
          );
          return toReportResponse(concurrentReport);
        }
      }
      await this.removeFinalizedOrThrow(finalizedKeys, error);
      throw error;
    }
    return toReportResponse(report);
  }

  async list(limit: number, offset = 0): Promise<ReportListResponse> {
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
      throw new BadRequestException(
        "limit must be an integer between 1 and 100."
      );
    }
    if (!Number.isSafeInteger(offset) || offset < 0) {
      throw new BadRequestException("offset must be a nonnegative integer.");
    }

    const records = await this.prisma.report.findMany({
      skip: offset,
      take: limit + 1,
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      include: reportInclude,
    });
    const hasMore = records.length > limit;
    const page = hasMore ? records.slice(0, limit) : records;
    return {
      data: page.map(toReportResponse),
      nextOffset: hasMore ? offset + page.length : null,
    };
  }

  async getById(id: string): Promise<ReportResponse> {
    const report = await this.prisma.report.findUnique({
      where: { id },
      include: reportInclude,
    });
    if (!report) {
      throw new NotFoundException("Report not found.");
    }
    return toReportResponse(report);
  }

  async getImage(
    reportId: string,
    imageId: string
  ): Promise<{
    path: string;
    mimeType: string;
    sizeBytes: number;
  }> {
    const image = await this.prisma.reportImage.findFirst({
      where: { id: imageId, reportId },
    });
    if (!image) {
      throw new NotFoundException("Report image not found.");
    }
    const imagePath = this.storage.resolveStorageKey(image.storageKey);
    try {
      await fs.access(imagePath);
    } catch (error) {
      if (
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        error.code === "ENOENT"
      ) {
        this.logger.error(
          `Persisted image file is missing: ${image.storageKey}`
        );
        throw new InternalServerErrorException(
          "Stored report image is unavailable.",
          { cause: error }
        );
      }
      throw error;
    }
    return {
      path: imagePath,
      mimeType: image.mimeType,
      sizeBytes: image.sizeBytes,
    };
  }

  async findByIdempotencyKey(key: string) {
    return this.prisma.report.findUnique({
      where: { idempotencyKey: key },
      include: reportInclude,
    });
  }

  private assertMatchingFingerprint(actual: string, expected: string): void {
    if (actual !== expected) {
      throw new ConflictException(
        "Idempotency-Key was already used with a different report payload."
      );
    }
  }

  private isIdempotencyConflict(error: unknown): boolean {
    if (
      !(error instanceof Prisma.PrismaClientKnownRequestError) ||
      error.code !== "P2002"
    ) {
      return false;
    }
    const target = error.meta?.target;
    return (
      target === "Report_idempotencyKey_key" ||
      (Array.isArray(target) && target.includes("idempotencyKey"))
    );
  }

  private async removeFinalizedOrThrow(
    storageKeys: string[],
    originalError: unknown
  ): Promise<void> {
    try {
      await this.storage.removeFinalized(storageKeys);
    } catch (cleanupError) {
      this.logger.error(
        `Failed to remove finalized images after report persistence failed: ${storageKeys.join(
          ", "
        )}`
      );
      throw new InternalServerErrorException(
        "Report persistence failed and stored image cleanup was incomplete.",
        { cause: cleanupError instanceof Error ? cleanupError : originalError }
      );
    }
  }
}
