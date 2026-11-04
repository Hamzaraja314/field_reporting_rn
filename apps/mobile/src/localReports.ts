import { getLocalDatabase } from './storage/database';
import { LocalImageStorage } from './storage/imageStorage';
import { LocalReportRepository } from './reports/reportRepository';
import { ReportQueueService } from './reports/reportQueueService';
import { ImageProcessingService } from './images/imageProcessing';
import { ReportImagePicker } from './images/reportImagePicker';

const imageStorage = new LocalImageStorage();

export const reportRepository = new LocalReportRepository(imageStorage);
export const reportQueueService = new ReportQueueService(reportRepository);
export const reportImagePicker = new ReportImagePicker();
export const imageProcessingService = new ImageProcessingService();

let initialization: Promise<void> | undefined;

export async function initializeLocalReports(): Promise<void> {
  if (!initialization) {
    initialization = (async () => {
      await getLocalDatabase();
      await imageProcessingService.cleanupTemporaryFiles();
      await reportRepository.cleanupOrphanedImages();
      await reportQueueService.recoverInterruptedUploads();
    })().catch(error => {
      initialization = undefined;
      throw error;
    });
  }
  await initialization;
}
