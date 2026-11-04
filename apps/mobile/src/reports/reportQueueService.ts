import { ReportValidationError, type LocalReport } from './model';
import { LocalReportRepository } from './reportRepository';

const retryableStatuses = ['queued', 'retrying'] as const;

export class ReportQueueService {
  constructor(private readonly reports: LocalReportRepository) {}

  queueReport(reportId: string): Promise<LocalReport> {
    return this.reports.queueReport(reportId);
  }

  listQueuedOrRetryable(): Promise<LocalReport[]> {
    return this.reports.listReportsByStatuses(retryableStatuses);
  }

  recordUploadAttempt(reportId: string): Promise<LocalReport> {
    return this.reports.transitionReport(reportId, 'uploading', {
      lastError: null,
    });
  }

  async recordTransientFailure(
    reportId: string,
    message: string,
  ): Promise<LocalReport> {
    const lastError = requireFailureMessage(message);
    const report = await this.reports.getReport(reportId);
    return this.reports.transitionReport(reportId, 'retrying', {
      lastError,
      retryCount: report.retryCount + 1,
    });
  }

  recordPermanentFailure(
    reportId: string,
    message: string,
  ): Promise<LocalReport> {
    return this.reports.transitionReport(reportId, 'failed', {
      lastError: requireFailureMessage(message),
    });
  }

  markUploaded(
    reportId: string,
    serverReportId: string,
    uploadedAt = new Date().toISOString(),
  ): Promise<LocalReport> {
    if (!serverReportId.trim()) {
      throw new ReportValidationError(
        'A server report ID is required to mark a report uploaded.',
      );
    }
    return this.reports.transitionReport(reportId, 'uploaded', {
      lastError: null,
      serverReportId,
      uploadedAt,
    });
  }

  recoverInterruptedUploads(): Promise<number> {
    return this.reports.recoverInterruptedUploads();
  }

  deleteUnsentReport(reportId: string): Promise<void> {
    return this.reports.deleteUnsentReport(reportId);
  }
}

function requireFailureMessage(message: string): string {
  const normalizedMessage = message.trim();
  if (!normalizedMessage) {
    throw new ReportValidationError('A failure message is required.');
  }
  return normalizedMessage;
}
