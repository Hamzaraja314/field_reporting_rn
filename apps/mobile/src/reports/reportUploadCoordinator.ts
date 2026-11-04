import { AppState, type NativeEventSubscription } from 'react-native';
import type { LocalReport } from './model';
import {
  ReportUploadClient,
  ReportUploadError,
} from './reportUploadClient';
import type { ReportQueueService } from './reportQueueService';
import type { ImageStorage } from '../storage/imageStorage';
import { MAX_IMAGE_SIZE_BYTES } from '../images/imageLimits';

const INITIAL_BACKOFF_MS = 15_000;
const MAX_BACKOFF_MS = 15 * 60_000;
const MAX_RETRY_AFTER_MS = 60 * 60_000;

export class ReportUploadCoordinator {
  private started = false;
  private foreground = AppState.currentState === 'active';
  private scanPromise: Promise<void> | null = null;
  private scanAgain = false;
  private scanAgainImmediately = false;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private appStateSubscription: NativeEventSubscription | null = null;
  private readonly listeners = new Set<(error?: string) => void>();

  constructor(
    private readonly queue: ReportQueueService,
    private readonly imageStorage: ImageStorage,
    private readonly client = new ReportUploadClient(),
    private readonly now: () => number = Date.now,
    private readonly random: () => number = Math.random,
  ) {}

  start(): void {
    if (this.started) {
      return;
    }
    this.started = true;
    this.appStateSubscription = AppState.addEventListener('change', state => {
      this.foreground = state === 'active';
      if (this.foreground) {
        this.scan().catch(error => this.notify(errorMessage(error)));
      }
    });
    this.scan().catch(error => this.notify(errorMessage(error)));
  }

  stop(): void {
    this.started = false;
    this.appStateSubscription?.remove();
    this.appStateSubscription = null;
    if (this.retryTimer) {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
  }

  subscribe(listener: (error?: string) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async scan(options: { retryImmediately?: boolean } = {}): Promise<void> {
    if (!this.started || !this.foreground) {
      return;
    }
    if (this.scanPromise) {
      this.scanAgain = true;
      this.scanAgainImmediately ||= options.retryImmediately === true;
      return this.scanPromise;
    }

    const activeScan = this.runScan(options.retryImmediately === true).catch(error => {
      this.notify(errorMessage(error));
    });
    this.scanPromise = activeScan;
    try {
      await activeScan;
    } finally {
      this.scanPromise = null;
      if (this.scanAgain && this.started && this.foreground) {
        this.scanAgain = false;
        const retryImmediately = this.scanAgainImmediately;
        this.scanAgainImmediately = false;
        await this.scan({ retryImmediately });
      }
    }
  }

  async retryFailedReport(reportId: string): Promise<void> {
    await this.queue.retryFailedReport(reportId);
    this.notify();
    await this.scan();
  }

  private async runScan(retryImmediately: boolean): Promise<void> {
    const reports = await this.queue.listQueuedOrRetryable();
    for (const report of reports) {
      if (
        !this.started ||
        !this.foreground ||
        (!retryImmediately && !isDue(report, this.now()))
      ) {
        continue;
      }
      await this.uploadOne(report);
    }
    this.scheduleNextAttempt(await this.queue.listQueuedOrRetryable());
  }

  private async uploadOne(report: LocalReport): Promise<void> {
    const current = await this.queue.recordUploadAttempt(report.localId);
    this.notify();
    try {
      await this.assertImagesReady(current);
      const response = await this.client.upload(current);
      await this.queue.markUploaded(current.localId, response.id);
    } catch (error) {
      if (error instanceof ReportUploadError && !error.retryable) {
        if (__DEV__) {
          console.error('[ReportUpload] upload permanently failed', {
            reportId: current.localId,
            attempt: current.uploadAttemptCount,
            classification: error.classification ?? 'permanent_failure',
          });
        }
        await this.queue.recordPermanentFailure(current.localId, error.message);
      } else {
        const failure =
          error instanceof ReportUploadError
            ? error
            : new ReportUploadError(
                'The upload could not be confirmed. It will be retried using the same idempotency key.',
                true,
              );
        const retryCount = current.retryCount + 1;
        const delay = retryDelay(
          retryCount,
          failure.retryAfterMs,
          this.random(),
        );
        const nextAttemptAt = new Date(this.now() + delay).toISOString();
        if (__DEV__) {
          console.warn('[ReportUpload] retry scheduled', {
            reportId: current.localId,
            attempt: current.uploadAttemptCount,
            classification: failure.classification ?? 'retryable_failure',
            retryable: true,
            nextAttemptAt,
            delayMs: delay,
          });
        }
        await this.queue.recordTransientFailure(
          current.localId,
          failure.message,
          nextAttemptAt,
        );
      }
    }
    this.notify();
  }

  private async assertImagesReady(report: LocalReport): Promise<void> {
    for (const image of report.images) {
      if (
        image.sizeBytes < 1 ||
        image.sizeBytes >= MAX_IMAGE_SIZE_BYTES ||
        !(await this.imageStorage.fileExists(image.filePath))
      ) {
        throw new ReportUploadError(
          'An attached image is missing or is no longer below the 5 MiB limit. Review the report before retrying.',
          false,
        );
      }
      if ((await this.imageStorage.fileSize(image.filePath)) !== image.sizeBytes) {
        throw new ReportUploadError(
          'An attached image changed after it was saved. Review the report before retrying.',
          false,
        );
      }
    }
  }

  private scheduleNextAttempt(reports: readonly LocalReport[]): void {
    if (this.retryTimer) {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
    const upcoming = reports
      .filter(report => report.status === 'retrying' && report.nextAttemptAt)
      .map(report => Date.parse(report.nextAttemptAt ?? ''))
      .filter(timestamp => Number.isFinite(timestamp) && timestamp > this.now());
    if (!upcoming.length || !this.started) {
      return;
    }
    const delay = Math.min(...upcoming) - this.now();
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      this.scan().catch(error => this.notify(errorMessage(error)));
    }, delay);
  }

  private notify(error?: string): void {
    for (const listener of this.listeners) {
      listener(error);
    }
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isDue(report: LocalReport, now: number): boolean {
  if (report.status !== 'retrying' || !report.nextAttemptAt) {
    return true;
  }
  const nextAttempt = Date.parse(report.nextAttemptAt);
  return Number.isFinite(nextAttempt) && nextAttempt <= now;
}

function retryDelay(
  retryCount: number,
  retryAfterMilliseconds: number | null,
  random: number,
): number {
  const exponential = Math.min(
    MAX_BACKOFF_MS,
    INITIAL_BACKOFF_MS * 2 ** Math.min(retryCount - 1, 16),
  );
  const jitter = exponential * (0.5 + Math.min(Math.max(random, 0), 1));
  const serverDelay = Math.min(
    MAX_RETRY_AFTER_MS,
    Math.max(0, retryAfterMilliseconds ?? 0),
  );
  return Math.min(MAX_RETRY_AFTER_MS, Math.max(jitter, serverDelay));
}
