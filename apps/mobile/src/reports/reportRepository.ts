import type { DB, Scalar, Transaction } from '@op-engineering/op-sqlite';
import { createLocalUuid } from '../ids';
import { getLocalDatabase } from '../storage/database';
import {
  type ImageStorage,
  type LocalImageInput,
  type StoredImageFile,
} from '../storage/imageStorage';
import {
  assertQueueableReport,
  assertReportTransition,
  isReportStatus,
  ReportValidationError,
  type LocalReport,
  type ReportStatus,
} from './model';
import {
  isSupportedImageMimeType,
  MAX_IMAGE_SIZE_BYTES,
  MAX_REPORT_IMAGES,
} from '../images/imageLimits';

interface StateRow {
  status: ReportStatus;
  retryCount: number;
  uploadAttemptCount: number;
}

export interface ReportStatusUpdate {
  lastError?: string | null;
  retryCount?: number;
  nextAttemptAt?: string | null;
  serverReportId?: string | null;
  uploadedAt?: string | null;
}

const reportSelect = `SELECT
    r.local_id,
    r.idempotency_key,
    r.description,
    r.created_at,
    r.updated_at,
    r.status,
    r.last_error,
    r.retry_count,
    r.upload_attempt_count,
    r.upload_started_at,
    r.next_attempt_at,
    r.server_report_id,
    r.uploaded_at,
    i.local_id AS image_local_id,
    i.report_id AS image_report_id,
    i.file_path AS image_file_path,
    i.original_file_name AS image_original_file_name,
    i.mime_type AS image_mime_type,
    i.size_bytes AS image_size_bytes,
    i.content_hash AS image_content_hash,
    i.order_index AS image_order_index,
    i.created_at AS image_created_at
  FROM reports r
  LEFT JOIN report_images i ON i.report_id = r.local_id`;

export class LocalReportRepository {
  private readonly processingReports = new Set<string>();

  constructor(
    private readonly imageStorage: ImageStorage,
    private readonly databaseProvider: () => Promise<DB> = getLocalDatabase,
    private readonly idGenerator: () => string = createLocalUuid,
    private readonly now: () => string = () => new Date().toISOString(),
  ) {}

  async createDraft(description = ''): Promise<LocalReport> {
    const database = await this.databaseProvider();
    const localId = this.idGenerator();
    const createdAt = this.now();
    await database.execute(
      `INSERT INTO reports (
        local_id, idempotency_key, description, created_at, updated_at, status
      ) VALUES (?, ?, ?, ?, ?, 'draft')`,
      [localId, localId, description, createdAt, createdAt],
    );
    return this.getReport(localId);
  }

  async updateDraftDescription(
    reportId: string,
    description: string,
  ): Promise<LocalReport> {
    const database = await this.databaseProvider();
    await database.transaction(async transaction => {
      const state = await this.getState(transaction, reportId);
      this.assertDraft(state.status);
      const result = await transaction.execute(
        `UPDATE reports SET description = ?, updated_at = ?
         WHERE local_id = ? AND status = 'draft'`,
        [description, this.now(), reportId],
      );
      this.assertOneRowChanged(result.rowsAffected, 'Report draft was not updated.');
    });
    return this.getReport(reportId);
  }

  async attachImages(
    reportId: string,
    inputs: readonly LocalImageInput[],
  ): Promise<LocalReport> {
    if (inputs.length === 0) {
      throw new ReportValidationError('Select at least one image to attach.');
    }

    const existing = await this.getReport(reportId);
    this.assertDraft(existing.status);
    if (existing.images.length + inputs.length > MAX_REPORT_IMAGES) {
      throw new ReportValidationError(
        'A report can include no more than five images.',
      );
    }

    const copiedFiles: StoredImageFile[] = [];
    try {
      const imageIds = inputs.map(() => this.idGenerator());
      for (const input of inputs) {
        copiedFiles.push(await this.imageStorage.copyImage(input));
      }

      const database = await this.databaseProvider();
      await database.transaction(async transaction => {
        const state = await this.getState(transaction, reportId);
        this.assertDraft(state.status);
        const imageCount = await this.getImageCount(transaction, reportId);
        if (imageCount + inputs.length > MAX_REPORT_IMAGES) {
          throw new ReportValidationError(
            'A report can include no more than five images.',
          );
        }

        const existingHashes = await transaction.execute(
          `SELECT content_hash FROM report_images
           WHERE report_id = ? AND content_hash IS NOT NULL`,
          [reportId],
        );
        const contentHashes = new Set(
          existingHashes.rows.map(row => stringField(row, 'content_hash')),
        );
        for (const file of copiedFiles) {
          if (file.contentHash && contentHashes.has(file.contentHash)) {
            throw new ReportValidationError(
              'This image is already attached to the report.',
            );
          }
          if (file.contentHash) {
            contentHashes.add(file.contentHash);
          }
        }

        for (let index = 0; index < inputs.length; index += 1) {
          const input = inputs[index];
          const file = copiedFiles[index];
          const result = await transaction.execute(
            `INSERT INTO report_images (
              local_id, report_id, file_path, original_file_name, mime_type,
              size_bytes, content_hash, order_index, created_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [
              imageIds[index],
              reportId,
              file.filePath,
              input.originalFileName ?? null,
              input.mimeType,
              file.sizeBytes,
              file.contentHash,
              imageCount + index,
              this.now(),
            ],
          );
          this.assertOneRowChanged(
            result.rowsAffected,
            'Image metadata was not saved.',
          );
        }
        await transaction.execute(
          'UPDATE reports SET updated_at = ? WHERE local_id = ?',
          [this.now(), reportId],
        );
      });
    } catch (error) {
      await this.cleanupFilesAndRethrow(copiedFiles, error);
    }

    return this.getReport(reportId);
  }

  async reorderImages(
    reportId: string,
    orderedImageIds: readonly string[],
  ): Promise<LocalReport> {
    const database = await this.databaseProvider();
    await database.transaction(async transaction => {
      const state = await this.getState(transaction, reportId);
      this.assertDraft(state.status);
      const rows = await transaction.execute(
        'SELECT local_id FROM report_images WHERE report_id = ? ORDER BY order_index',
        [reportId],
      );
      const currentIds = rows.rows.map(row => stringField(row, 'local_id'));
      if (
        currentIds.length !== orderedImageIds.length ||
        new Set(orderedImageIds).size !== orderedImageIds.length ||
        currentIds.some(id => !orderedImageIds.includes(id))
      ) {
        throw new ReportValidationError(
          'The image order must contain every attached image exactly once.',
        );
      }

      await transaction.execute(
        'UPDATE report_images SET order_index = order_index + 5 WHERE report_id = ?',
        [reportId],
      );
      for (let index = 0; index < orderedImageIds.length; index += 1) {
        await transaction.execute(
          `UPDATE report_images SET order_index = ?
           WHERE report_id = ? AND local_id = ?`,
          [index, reportId, orderedImageIds[index]],
        );
      }
      await transaction.execute(
        'UPDATE reports SET updated_at = ? WHERE local_id = ?',
        [this.now(), reportId],
      );
    });
    return this.getReport(reportId);
  }

  async getReport(reportId: string): Promise<LocalReport> {
    const database = await this.databaseProvider();
    const result = await database.execute(
      `${reportSelect} WHERE r.local_id = ? ORDER BY i.order_index`,
      [reportId],
    );
    const report = mapReports(result.rows)[0];
    if (!report) {
      throw new Error('Local report was not found.');
    }
    return report;
  }

  async listReports(): Promise<LocalReport[]> {
    const database = await this.databaseProvider();
    const result = await database.execute(
      `${reportSelect} ORDER BY r.created_at DESC, r.local_id DESC, i.order_index`,
    );
    return mapReports(result.rows);
  }

  async listReportsByStatuses(
    statuses: readonly ReportStatus[],
  ): Promise<LocalReport[]> {
    if (statuses.length === 0) {
      return [];
    }
    const database = await this.databaseProvider();
    const placeholders = statuses.map(() => '?').join(', ');
    const result = await database.execute(
      `${reportSelect} WHERE r.status IN (${placeholders})
       ORDER BY r.created_at ASC, r.local_id ASC, i.order_index`,
      [...statuses],
    );
    return mapReports(result.rows);
  }

  async queueReport(reportId: string): Promise<LocalReport> {
    this.assertImagesNotProcessing(reportId);
    const database = await this.databaseProvider();
    await database.transaction(async transaction => {
      this.assertImagesNotProcessing(reportId);
      const report = await this.getQueueFields(transaction, reportId);
      if (report.status !== 'draft') {
        throw new ReportValidationError('Only a draft report can be queued.');
      }
      assertQueueableReport(report.description, report.imageCount);
      assertReportTransition(report.status, 'queued');
      const imageResult = await transaction.execute(
        `SELECT file_path, size_bytes, mime_type
         FROM report_images WHERE report_id = ? ORDER BY order_index`,
        [reportId],
      );
      for (const row of imageResult.rows) {
        const filePath = stringField(row, 'file_path');
        const sizeBytes = numberField(row, 'size_bytes');
        const mimeType = stringField(row, 'mime_type');
        if (
          !isSupportedImageMimeType(mimeType) ||
          sizeBytes < 1 ||
          sizeBytes >= MAX_IMAGE_SIZE_BYTES ||
          !imagePathMatchesMimeType(filePath, mimeType)
        ) {
          throw new ReportValidationError(
            'Every attached image must be a supported format and smaller than 5 MiB.',
          );
        }
        if (!(await this.imageStorage.fileExists(filePath))) {
          throw new ReportValidationError(
            'A saved image is missing from private storage; this report cannot be queued.',
          );
        }
        const actualSize = await this.imageStorage.fileSize(filePath);
        if (actualSize !== sizeBytes || actualSize >= MAX_IMAGE_SIZE_BYTES) {
          throw new ReportValidationError(
            'A saved image changed or is no longer below the 5 MiB limit.',
          );
        }
      }
      const result = await transaction.execute(
        `UPDATE reports SET status = 'queued', updated_at = ?
         WHERE local_id = ? AND status = ?`,
        [this.now(), reportId, report.status],
      );
      this.assertOneRowChanged(result.rowsAffected, 'Report could not be queued.');
    });
    return this.getReport(reportId);
  }

  async transitionReport(
    reportId: string,
    nextStatus: ReportStatus,
    update: ReportStatusUpdate = {},
  ): Promise<LocalReport> {
    const database = await this.databaseProvider();
    await database.transaction(async transaction => {
      const current = await this.getState(transaction, reportId);
      assertReportTransition(current.status, nextStatus);
      const lastError =
        update.lastError === undefined ? null : update.lastError;
      const retryCount = update.retryCount ?? current.retryCount;
      const uploadAttemptCount =
        current.uploadAttemptCount + (nextStatus === 'uploading' ? 1 : 0);
      const changedAt = this.now();
      const uploadStartedAt =
        nextStatus === 'uploading' ? changedAt : null;
      const nextAttemptAt = update.nextAttemptAt ?? null;
      const serverReportId = update.serverReportId ?? null;
      const uploadedAt = update.uploadedAt ?? null;
      if (
        nextStatus === 'uploaded' &&
        (!serverReportId || !uploadedAt)
      ) {
        throw new ReportValidationError(
          'A server report ID and upload timestamp are required to mark a report uploaded.',
        );
      }

      const result = await transaction.execute(
        `UPDATE reports SET
           status = ?, updated_at = ?, last_error = ?, retry_count = ?,
           upload_attempt_count = ?, upload_started_at = ?, next_attempt_at = ?,
           server_report_id = ?, uploaded_at = ?
         WHERE local_id = ? AND status = ?`,
        [
          nextStatus,
          changedAt,
          lastError,
          retryCount,
          uploadAttemptCount,
          uploadStartedAt,
          nextAttemptAt,
          serverReportId,
          uploadedAt,
          reportId,
          current.status,
        ],
      );
      this.assertOneRowChanged(
        result.rowsAffected,
        'Report state changed before the operation could be saved.',
      );
    });
    return this.getReport(reportId);
  }

  async recoverInterruptedUploads(): Promise<number> {
    const database = await this.databaseProvider();
    let recoveredCount = 0;
    await database.transaction(async transaction => {
      const result = await transaction.execute(
        `SELECT local_id, status FROM reports WHERE status = 'uploading'`,
      );
      for (const row of result.rows) {
        const status = statusField(row, 'status');
        assertReportTransition(status, 'retrying');
        const updateResult = await transaction.execute(
          `UPDATE reports SET status = 'retrying', last_error = ?,
             next_attempt_at = NULL, upload_started_at = NULL,
             updated_at = ? WHERE local_id = ? AND status = 'uploading'`,
          [
            'Upload was interrupted before completion.',
            this.now(),
            stringField(row, 'local_id'),
          ],
        );
        this.assertOneRowChanged(
          updateResult.rowsAffected,
          'An interrupted report could not be recovered.',
        );
        recoveredCount += 1;
      }
    });
    return recoveredCount;
  }

  async retryFailedReport(reportId: string): Promise<LocalReport> {
    const database = await this.databaseProvider();
    await database.transaction(async transaction => {
      const current = await this.getState(transaction, reportId);
      assertReportTransition(current.status, 'queued');
      const result = await transaction.execute(
        `UPDATE reports SET status = 'queued', last_error = NULL,
           next_attempt_at = NULL, upload_started_at = NULL, updated_at = ?
         WHERE local_id = ? AND status = 'failed'`,
        [this.now(), reportId],
      );
      this.assertOneRowChanged(
        result.rowsAffected,
        'Failed report could not be queued for manual retry.',
      );
    });
    return this.getReport(reportId);
  }

  async replaceImageFile(
    reportId: string,
    imageId: string,
    input: LocalImageInput,
  ): Promise<LocalReport> {
    const report = await this.getReport(reportId);
    this.assertDraft(report.status);
    const oldImage = report.images.find(image => image.localId === imageId);
    if (!oldImage) {
      throw new Error('Local report image was not found.');
    }

    const newFile = await this.imageStorage.copyImage(input);
    try {
      const database = await this.databaseProvider();
      await database.transaction(async transaction => {
        const state = await this.getState(transaction, reportId);
        this.assertDraft(state.status);
        const result = await transaction.execute(
          `UPDATE report_images SET
             file_path = ?, original_file_name = ?, mime_type = ?,
             size_bytes = ?, content_hash = ?
           WHERE local_id = ? AND report_id = ?`,
          [
            newFile.filePath,
            input.originalFileName ?? null,
            input.mimeType,
            newFile.sizeBytes,
            newFile.contentHash,
            imageId,
            reportId,
          ],
        );
        this.assertOneRowChanged(
          result.rowsAffected,
          'Replacement image metadata was not saved.',
        );
        await transaction.execute(
          'UPDATE reports SET updated_at = ? WHERE local_id = ?',
          [this.now(), reportId],
        );
      });
    } catch (error) {
      await this.cleanupFilesAndRethrow([newFile], error);
    }

    await this.removeIfUnreferenced([oldImage.filePath]);
    return this.getReport(reportId);
  }

  async removeImage(reportId: string, imageId: string): Promise<LocalReport> {
    this.assertImagesNotProcessing(reportId);
    const database = await this.databaseProvider();
    let filePath = '';
    await database.transaction(async transaction => {
      const state = await this.getState(transaction, reportId);
      this.assertDraft(state.status);
      const imageResult = await transaction.execute(
        `SELECT file_path FROM report_images
         WHERE report_id = ? AND local_id = ?`,
        [reportId, imageId],
      );
      const image = imageResult.rows[0];
      if (!image) {
        throw new Error('Local report image was not found.');
      }
      filePath = stringField(image, 'file_path');
      const deleteResult = await transaction.execute(
        'DELETE FROM report_images WHERE report_id = ? AND local_id = ?',
        [reportId, imageId],
      );
      this.assertOneRowChanged(
        deleteResult.rowsAffected,
        'Local report image was not removed.',
      );

      const remainingImages = await transaction.execute(
        `SELECT local_id FROM report_images
         WHERE report_id = ? ORDER BY order_index`,
        [reportId],
      );
      await transaction.execute(
        'UPDATE report_images SET order_index = order_index + 5 WHERE report_id = ?',
        [reportId],
      );
      for (let index = 0; index < remainingImages.rows.length; index += 1) {
        await transaction.execute(
          `UPDATE report_images SET order_index = ?
           WHERE report_id = ? AND local_id = ?`,
          [
            index,
            reportId,
            stringField(remainingImages.rows[index], 'local_id'),
          ],
        );
      }
      await transaction.execute(
        'UPDATE reports SET updated_at = ? WHERE local_id = ?',
        [this.now(), reportId],
      );
    });
    await this.removeIfUnreferenced([filePath]);
    return this.getReport(reportId);
  }

  async deleteUnsentReport(reportId: string): Promise<void> {
    const database = await this.databaseProvider();
    let filePaths: string[] = [];
    await database.transaction(async transaction => {
      const result = await transaction.execute(
        `SELECT status, server_report_id FROM reports WHERE local_id = ?`,
        [reportId],
      );
      const row = result.rows[0];
      if (!row) {
        throw new Error('Local report was not found.');
      }
      const status = statusField(row, 'status');
      const serverReportId = nullableStringField(row, 'server_report_id');
      if (
        status === 'uploading' ||
        status === 'uploaded' ||
        serverReportId !== null
      ) {
        throw new ReportValidationError(
          'A report that may have reached the server cannot be deleted locally.',
        );
      }

      const imageResult = await transaction.execute(
        'SELECT file_path FROM report_images WHERE report_id = ?',
        [reportId],
      );
      filePaths = imageResult.rows.map(imageRow =>
        stringField(imageRow, 'file_path'),
      );
      const deleteResult = await transaction.execute(
        'DELETE FROM reports WHERE local_id = ?',
        [reportId],
      );
      this.assertOneRowChanged(
        deleteResult.rowsAffected,
        'Local report was not deleted.',
      );
    });
    await this.removeIfUnreferenced(filePaths);
  }

  async cleanupOrphanedImages(): Promise<void> {
    const database = await this.databaseProvider();
    const result = await database.execute('SELECT file_path FROM report_images');
    const referencedPaths = new Set(
      result.rows.map(row => stringField(row, 'file_path')),
    );
    await this.imageStorage.removeOrphanedFiles(referencedPaths);
  }

  async beginImageProcessing(reportId: string): Promise<void> {
    if (this.processingReports.has(reportId)) {
      throw new ReportValidationError(
        'Images are already being processed for this report.',
      );
    }
    const report = await this.getReport(reportId);
    this.assertDraft(report.status);
    this.processingReports.add(reportId);
  }

  endImageProcessing(reportId: string): void {
    this.processingReports.delete(reportId);
  }

  private assertImagesNotProcessing(reportId: string): void {
    if (this.processingReports.has(reportId)) {
      throw new ReportValidationError(
        'Wait for image processing to finish before queueing this report.',
      );
    }
  }

  private async getState(
    transaction: Transaction,
    reportId: string,
  ): Promise<StateRow> {
    const result = await transaction.execute(
      `SELECT status, retry_count, upload_attempt_count
       FROM reports WHERE local_id = ?`,
      [reportId],
    );
    const row = result.rows[0];
    if (!row) {
      throw new Error('Local report was not found.');
    }
    return {
      status: statusField(row, 'status'),
      retryCount: numberField(row, 'retry_count'),
      uploadAttemptCount: numberField(row, 'upload_attempt_count'),
    };
  }

  private async getImageCount(
    transaction: Transaction,
    reportId: string,
  ): Promise<number> {
    const result = await transaction.execute(
      'SELECT COUNT(*) AS image_count FROM report_images WHERE report_id = ?',
      [reportId],
    );
    return numberField(result.rows[0] ?? {}, 'image_count');
  }

  private async getQueueFields(
    transaction: Transaction,
    reportId: string,
  ): Promise<{ status: ReportStatus; description: string; imageCount: number }> {
    const result = await transaction.execute(
      `SELECT r.status, r.description,
       (SELECT COUNT(*) FROM report_images i WHERE i.report_id = r.local_id) AS image_count
       FROM reports r WHERE r.local_id = ?`,
      [reportId],
    );
    const row = result.rows[0];
    if (!row) {
      throw new Error('Local report was not found.');
    }
    return {
      status: statusField(row, 'status'),
      description: stringField(row, 'description'),
      imageCount: numberField(row, 'image_count'),
    };
  }

  private assertDraft(status: ReportStatus): void {
    if (status !== 'draft') {
      throw new ReportValidationError(
        'Only a draft report can be edited.',
      );
    }
  }

  private assertOneRowChanged(rowsAffected: number, message: string): void {
    if (rowsAffected !== 1) {
      throw new Error(message);
    }
  }

  private async cleanupFilesAndRethrow(
    files: readonly StoredImageFile[],
    originalError: unknown,
  ): Promise<never> {
    const results = await Promise.all(
      files.map(async file => {
        try {
          await this.imageStorage.removeFile(file.filePath);
          return null;
        } catch (error) {
          return error;
        }
      }),
    );
    const cleanupError = results.find(result => result !== null);
    if (cleanupError) {
      throw new Error(
        `Local database operation failed and copied image cleanup was incomplete: ${errorMessage(cleanupError)} (operation error: ${errorMessage(originalError)})`,
      );
    }
    throw originalError;
  }

  private async removeIfUnreferenced(filePaths: readonly string[]): Promise<void> {
    const database = await this.databaseProvider();
    for (const filePath of new Set(filePaths)) {
      const result = await database.execute(
        'SELECT COUNT(*) AS reference_count FROM report_images WHERE file_path = ?',
        [filePath],
      );
      if (numberField(result.rows[0] ?? {}, 'reference_count') === 0) {
        await this.imageStorage.removeFile(filePath);
      }
    }
  }
}

function mapReports(rows: Record<string, Scalar>[]): LocalReport[] {
  const reports = new Map<string, LocalReport>();

  for (const row of rows) {
    const localId = stringField(row, 'local_id');
    let report = reports.get(localId);
    if (!report) {
      report = {
        localId,
        idempotencyKey: stringField(row, 'idempotency_key'),
        description: stringField(row, 'description'),
        createdAt: stringField(row, 'created_at'),
        updatedAt: stringField(row, 'updated_at'),
        status: statusField(row, 'status'),
        lastError: nullableStringField(row, 'last_error'),
        retryCount: numberField(row, 'retry_count'),
        uploadAttemptCount: numberField(row, 'upload_attempt_count'),
        uploadStartedAt: nullableStringField(row, 'upload_started_at'),
        nextAttemptAt: nullableStringField(row, 'next_attempt_at'),
        serverReportId: nullableStringField(row, 'server_report_id'),
        uploadedAt: nullableStringField(row, 'uploaded_at'),
        images: [],
      };
      reports.set(localId, report);
    }

    if (row.image_local_id !== null && row.image_local_id !== undefined) {
      report.images.push({
        localId: stringField(row, 'image_local_id'),
        reportId: stringField(row, 'image_report_id'),
        filePath: stringField(row, 'image_file_path'),
        originalFileName: nullableStringField(
          row,
          'image_original_file_name',
        ),
        mimeType: stringField(row, 'image_mime_type'),
        sizeBytes: numberField(row, 'image_size_bytes'),
        contentHash: nullableStringField(row, 'image_content_hash'),
        orderIndex: numberField(row, 'image_order_index'),
        createdAt: stringField(row, 'image_created_at'),
      });
    }
  }
  return [...reports.values()];
}

function stringField(row: Record<string, Scalar>, field: string): string {
  const value = row[field];
  if (typeof value !== 'string') {
    throw new Error(`Local database returned invalid ${field} data.`);
  }
  return value;
}

function nullableStringField(
  row: Record<string, Scalar>,
  field: string,
): string | null {
  const value = row[field];
  if (value === null || value === undefined) {
    return null;
  }
  if (typeof value !== 'string') {
    throw new Error(`Local database returned invalid ${field} data.`);
  }
  return value;
}

function numberField(row: Record<string, Scalar>, field: string): number {
  const value = Number(row[field]);
  if (!Number.isSafeInteger(value)) {
    throw new Error(`Local database returned invalid ${field} data.`);
  }
  return value;
}

function statusField(
  row: Record<string, Scalar>,
  field: string,
): ReportStatus {
  const status = row[field];
  if (!isReportStatus(status)) {
    throw new Error(`Local database returned invalid ${field} state.`);
  }
  return status;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function imagePathMatchesMimeType(filePath: string, mimeType: string): boolean {
  const extension = filePath.toLowerCase().split('.').pop();
  return mimeType === 'image/jpeg'
    ? extension === 'jpg' || extension === 'jpeg'
    : mimeType === 'image/png'
      ? extension === 'png'
      : extension === 'webp';
}
