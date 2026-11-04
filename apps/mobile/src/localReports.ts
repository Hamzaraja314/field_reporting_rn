import { getLocalDatabase } from './storage/database';
import { LocalImageStorage } from './storage/imageStorage';
import { LocalReportRepository } from './reports/reportRepository';
import { ReportQueueService } from './reports/reportQueueService';

const imageStorage = new LocalImageStorage();

export const reportRepository = new LocalReportRepository(imageStorage);
export const reportQueueService = new ReportQueueService(reportRepository);

export async function initializeLocalReports(): Promise<void> {
  await getLocalDatabase();
  await reportRepository.cleanupOrphanedImages();
  await reportQueueService.recoverInterruptedUploads();
}
