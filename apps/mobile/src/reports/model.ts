export const reportStatuses = [
  'draft',
  'queued',
  'uploading',
  'retrying',
  'uploaded',
  'failed',
] as const;

export type ReportStatus = (typeof reportStatuses)[number];

export interface LocalReportImage {
  localId: string;
  reportId: string;
  filePath: string;
  originalFileName: string | null;
  mimeType: string;
  sizeBytes: number;
  contentHash: string | null;
  orderIndex: number;
  createdAt: string;
}

export interface LocalReport {
  localId: string;
  idempotencyKey: string;
  description: string;
  createdAt: string;
  updatedAt: string;
  status: ReportStatus;
  lastError: string | null;
  retryCount: number;
  uploadAttemptCount: number;
  uploadStartedAt: string | null;
  nextAttemptAt: string | null;
  serverReportId: string | null;
  uploadedAt: string | null;
  images: LocalReportImage[];
}

export class ReportValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ReportValidationError';
  }
}

const legalTransitions: Record<ReportStatus, readonly ReportStatus[]> = {
  draft: ['queued'],
  queued: ['uploading', 'failed'],
  uploading: ['retrying', 'uploaded', 'failed'],
  retrying: ['uploading', 'uploaded', 'failed'],
  uploaded: [],
  failed: ['queued'],
};

export function isReportStatus(value: unknown): value is ReportStatus {
  return (
    typeof value === 'string' &&
    reportStatuses.includes(value as ReportStatus)
  );
}

export function assertReportTransition(
  current: ReportStatus,
  next: ReportStatus,
): void {
  if (!legalTransitions[current].includes(next)) {
    throw new ReportValidationError(
      `A report cannot transition from "${current}" to "${next}".`,
    );
  }
}

export function assertQueueableReport(
  description: string,
  imageCount: number,
): void {
  if (!description.trim()) {
    throw new ReportValidationError(
      'Enter a description before queueing this report.',
    );
  }
  if (imageCount < 1) {
    throw new ReportValidationError(
      'Attach at least one image before queueing this report.',
    );
  }
  if (imageCount > 5) {
    throw new ReportValidationError(
      'A report can include no more than five images.',
    );
  }
}
