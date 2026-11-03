import { ApiProperty } from "@nestjs/swagger";
import type {
  ReportImageResponse,
  ReportResponse,
} from "@field-reporting/types";
import type { Report } from "@prisma/client";

export class ReportImageResponseDto implements ReportImageResponse {
  @ApiProperty({ format: "uuid" })
  id!: string;

  @ApiProperty({ enum: ["image/jpeg", "image/png", "image/webp"] })
  mimeType!: string;

  @ApiProperty({ minimum: 1 })
  sizeBytes!: number;

  @ApiProperty({ minimum: 0, maximum: 4 })
  orderIndex!: number;

  @ApiProperty({ example: "/api/v1/reports/{reportId}/images/{imageId}" })
  url!: string;
}

export class ReportResponseDto implements ReportResponse {
  @ApiProperty({ format: "uuid" })
  id!: string;

  @ApiProperty()
  description!: string;

  @ApiProperty({ format: "date-time" })
  createdAt!: string;

  @ApiProperty({ type: [ReportImageResponseDto], minItems: 1, maxItems: 5 })
  images!: ReportImageResponseDto[];
}

type ReportWithImages = Report & {
  images: Array<{
    id: string;
    mimeType: string;
    sizeBytes: number;
    orderIndex: number;
  }>;
};

export function toReportResponse(report: ReportWithImages): ReportResponseDto {
  return {
    id: report.id,
    description: report.description,
    createdAt: report.createdAt.toISOString(),
    images: report.images.map(
      (image): ReportImageResponse => ({
        id: image.id,
        mimeType: image.mimeType,
        sizeBytes: image.sizeBytes,
        orderIndex: image.orderIndex,
        url: `/api/v1/reports/${report.id}/images/${image.id}`,
      })
    ),
  };
}
