export interface CreateReportFormFields {
  description: string;
}

export interface ReportImageResponse {
  id: string;
  mimeType: string;
  sizeBytes: number;
  orderIndex: number;
  url: string;
}

export interface ReportResponse {
  id: string;
  description: string;
  createdAt: string;
  images: ReportImageResponse[];
}

export interface ReportListResponse {
  data: ReportResponse[];
  nextOffset: number | null;
}
