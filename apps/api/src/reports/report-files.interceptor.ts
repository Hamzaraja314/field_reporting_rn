import {
  BadRequestException,
  CallHandler,
  ExecutionContext,
  Injectable,
  InternalServerErrorException,
  NestInterceptor,
  PayloadTooLargeException,
} from "@nestjs/common";
import { randomUUID } from "node:crypto";
import { Observable, lastValueFrom, of } from "rxjs";
import multer from "multer";
import { Request, Response } from "express";
import {
  ReportStorageService,
  MAX_IMAGE_BYTES,
} from "./report-storage.service";

type UploadRequest = Request & { uploadDirectory?: string };

@Injectable()
export class ReportFilesInterceptor implements NestInterceptor {
  constructor(private readonly storage: ReportStorageService) {}

  async intercept(
    context: ExecutionContext,
    next: CallHandler
  ): Promise<Observable<unknown>> {
    const http = context.switchToHttp();
    const request = http.getRequest<UploadRequest>();
    const response = http.getResponse<Response>();
    const uploadDirectory = await this.storage.createRequestDirectory();
    request.uploadDirectory = uploadDirectory;

    const upload = multer({
      storage: multer.diskStorage({
        destination: uploadDirectory,
        filename: (_req, _file, callback) => callback(null, randomUUID()),
      }),
      limits: {
        files: 5,
        fileSize: MAX_IMAGE_BYTES,
        fields: 1,
        parts: 7,
        fieldNameSize: 100,
        fieldSize: 64 * 1024,
        headerPairs: 100,
      },
    }).any();

    try {
      await new Promise<void>((resolve, reject) => {
        upload(request, response, (error: unknown) =>
          error ? reject(error) : resolve()
        );
      });
      const result = await lastValueFrom(next.handle());
      return of(result);
    } catch (error) {
      if (
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        error.code === "LIMIT_FILE_SIZE"
      ) {
        throw new PayloadTooLargeException("Images must not exceed 5 MiB.");
      }
      if (
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        error.code === "LIMIT_FILE_COUNT"
      ) {
        throw new BadRequestException(
          "A report must include one to five images."
        );
      }
      if (
        error instanceof multer.MulterError ||
        (error instanceof Error &&
          [
            "Malformed part header",
            "Multipart: Boundary not found",
            "Multipart: Boundary is not a string",
            "Unexpected end of form",
          ].includes(error.message))
      ) {
        throw new BadRequestException(
          "Malformed or incomplete multipart upload."
        );
      }
      throw error;
    } finally {
      try {
        await this.storage.removeRequestDirectory(uploadDirectory);
      } catch (error) {
        if (error instanceof Error) {
          throw new InternalServerErrorException(
            "Unable to clean up temporary upload files.",
            { cause: error }
          );
        }
        throw error;
      }
    }
  }
}
