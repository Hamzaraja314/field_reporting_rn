import ReactNativeBlobUtil from 'react-native-blob-util';
import { createLocalUuid } from '../ids';
import { MAX_IMAGE_SIZE_BYTES } from '../images/imageLimits';
import {
  copyImageUriToPath,
  ImageUriCopyError,
} from './imageUriCopy';

export interface LocalImageInput {
  uri: string;
  mimeType: string;
  originalFileName?: string | null;
}

export interface StoredImageFile {
  filePath: string;
  sizeBytes: number;
  contentHash: string | null;
}

export interface ImageStorage {
  copyImage(input: LocalImageInput): Promise<StoredImageFile>;
  fileExists(filePath: string): Promise<boolean>;
  fileSize(filePath: string): Promise<number>;
  removeFile(filePath: string): Promise<void>;
  removeOrphanedFiles(referencedPaths: ReadonlySet<string>): Promise<void>;
}

const extensionByMimeType: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
};

const managedFileName = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.(jpg|png|webp)$/i;

export class LocalImageStorage implements ImageStorage {
  private readonly directory = `${ReactNativeBlobUtil.fs.dirs.DocumentDir}/report-images`;
  private directoryPromise: Promise<void> | undefined;

  async copyImage(input: LocalImageInput): Promise<StoredImageFile> {
    const extension = extensionByMimeType[input.mimeType];
    if (!extension) {
      throw new Error('Only JPEG, PNG, and WebP images can be stored.');
    }

    const filePath = `${this.directory}/${createLocalUuid()}.${extension}`;

    try {
      await this.ensureDirectory();
      await this.copyIntoPrivateStorage(input.uri, filePath);
      const file = await ReactNativeBlobUtil.fs.stat(filePath);
      const sizeBytes = Number(file.size);
      if (!Number.isSafeInteger(sizeBytes) || sizeBytes < 1) {
        throw new Error('The selected image is empty or has an invalid size.');
      }
      if (sizeBytes >= MAX_IMAGE_SIZE_BYTES) {
        throw new Error('Images must be smaller than 5 MiB before they are attached.');
      }

      const contentHash = await ReactNativeBlobUtil.fs.hash(
        filePath,
        'sha256',
      );
      return { filePath, sizeBytes, contentHash };
    } catch (error) {
      if (__DEV__) {
        console.warn('[image-storage] Unable to persist selected image', error);
      }
      try {
        await this.cleanupFailedCopy(filePath, error);
      } catch (cleanupError) {
        if (__DEV__) {
          console.warn(
            '[image-storage] Partial image cleanup failed',
            cleanupError,
          );
        }
        throw new Error(
          'The image could not be saved and a partial file could not be cleaned up. Restart the app before retrying.',
        );
      }
      if (error instanceof ImageUriCopyError) {
        throw new Error(error.message);
      }
      const message = error instanceof Error ? error.message : '';
      if (
        /smaller than 5 MiB|empty or has an invalid size|Only JPEG, PNG, and WebP/i.test(
          message,
        )
      ) {
        throw error;
      }
      throw new Error(
        'The image could not be saved to private storage. Please retry.',
      );
    }
  }

  async fileExists(filePath: string): Promise<boolean> {
    this.assertManagedPath(filePath);
    return ReactNativeBlobUtil.fs.exists(filePath);
  }

  async fileSize(filePath: string): Promise<number> {
    this.assertManagedPath(filePath);
    const file = await ReactNativeBlobUtil.fs.stat(filePath);
    const sizeBytes = Number(file.size);
    if (!Number.isSafeInteger(sizeBytes) || sizeBytes < 1) {
      throw new Error('A saved image has an invalid file size.');
    }
    return sizeBytes;
  }

  async removeFile(filePath: string): Promise<void> {
    this.assertManagedPath(filePath);
    if (await ReactNativeBlobUtil.fs.exists(filePath)) {
      await ReactNativeBlobUtil.fs.unlink(filePath);
    }
  }

  async removeOrphanedFiles(referencedPaths: ReadonlySet<string>): Promise<void> {
    await this.ensureDirectory();
    const fileNames = await ReactNativeBlobUtil.fs.ls(this.directory);
    for (const fileName of fileNames) {
      if (!managedFileName.test(fileName)) {
        continue;
      }
      const filePath = `${this.directory}/${fileName}`;
      if (!referencedPaths.has(filePath)) {
        await this.removeFile(filePath);
      }
    }
  }

  private async ensureDirectory(): Promise<void> {
    if (!this.directoryPromise) {
      this.directoryPromise = (async () => {
        if (!(await ReactNativeBlobUtil.fs.exists(this.directory))) {
          await ReactNativeBlobUtil.fs.mkdir(this.directory);
        }
        if (!(await ReactNativeBlobUtil.fs.exists(this.directory))) {
          throw new Error('Private report image storage is unavailable.');
        }
      })().catch(error => {
        this.directoryPromise = undefined;
        throw error;
      });
    }
    await this.directoryPromise;
  }

  private async copyIntoPrivateStorage(
    sourceUri: string,
    destinationPath: string,
  ): Promise<void> {
    await copyImageUriToPath(sourceUri, destinationPath, {
      copyFile: (source, destination) =>
        ReactNativeBlobUtil.fs.cp(source, destination),
      copyContentUri: (source, destination) =>
        ReactNativeBlobUtil.MediaCollection.copyToInternal(
          source,
          destination,
        ),
      exists: path => ReactNativeBlobUtil.fs.exists(path),
      remove: async path => {
        if (await ReactNativeBlobUtil.fs.exists(path)) {
          await ReactNativeBlobUtil.fs.unlink(path);
        }
      },
    });
  }

  private assertManagedPath(filePath: string): void {
    const prefix = `${this.directory}/`;
    const fileName = filePath.startsWith(prefix)
      ? filePath.slice(prefix.length)
      : '';
    if (!managedFileName.test(fileName)) {
      throw new Error('Refusing to access a file outside report image storage.');
    }
  }

  private async cleanupFailedCopy(
    filePath: string,
    originalError: unknown,
  ): Promise<void> {
    try {
      if (await ReactNativeBlobUtil.fs.exists(filePath)) {
        await ReactNativeBlobUtil.fs.unlink(filePath);
      }
    } catch (cleanupError) {
      throw new Error(
        `Image copy failed and its partial file could not be removed: ${errorMessage(cleanupError)} (copy error: ${errorMessage(originalError)})`,
      );
    }
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
