import ImageResizer, {
  type ResizeFormat,
} from '@bam.tech/react-native-image-resizer';
import ReactNativeBlobUtil from 'react-native-blob-util';
import { Image, Platform } from 'react-native';
import { createLocalUuid } from '../ids';
import type { LocalImageInput } from '../storage/imageStorage';
import {
  copyImageUriToPath,
  ImageUriCopyError,
} from '../storage/imageUriCopy';
import {
  isSupportedImageMimeType,
  MAX_IMAGE_DIMENSION,
  MAX_IMAGE_SIZE_BYTES,
  type SupportedImageMimeType,
} from './imageLimits';

const qualitySteps = [88, 75, 60] as const;
const minimumDimension = 320;

export interface ImageDimensions {
  width: number;
  height: number;
}

export interface ImageFileInfo {
  sizeBytes: number;
}

export interface ImageProcessingFileSystem {
  ensureTemporaryDirectory(): Promise<void>;
  temporaryDirectory(): string;
  copyToTemporary(sourceUri: string, destinationPath: string): Promise<void>;
  stat(path: string): Promise<ImageFileInfo>;
  exists(path: string): Promise<boolean>;
  remove(path: string): Promise<void>;
  listTemporaryFiles(): Promise<string[]>;
}

export interface ImageProcessingDependencies {
  fileSystem: ImageProcessingFileSystem;
  getDimensions(uri: string): Promise<ImageDimensions>;
  resize(
    uri: string,
    maxDimension: number,
    format: ResizeFormat,
    quality: number,
    outputDirectory: string,
  ): Promise<{ path: string; name: string }>;
  createId(): string;
  platform: string;
}

export interface ProcessedReportImage extends LocalImageInput {
  uri: string;
  mimeType: SupportedImageMimeType;
  sizeBytes: number;
}

export interface ImageProcessingProgress {
  completed: number;
  total: number;
}

const temporaryDirectory = `${ReactNativeBlobUtil.fs.dirs.DocumentDir}/field-reporting-image-processing`;

const defaultFileSystem: ImageProcessingFileSystem = {
  temporaryDirectory: () => temporaryDirectory,
  async ensureTemporaryDirectory() {
    if (!(await ReactNativeBlobUtil.fs.exists(temporaryDirectory))) {
      await ReactNativeBlobUtil.fs.mkdir(temporaryDirectory);
    }
    if (!(await ReactNativeBlobUtil.fs.exists(temporaryDirectory))) {
      throw new Error('The private image processing directory is unavailable.');
    }
  },
  async copyToTemporary(sourceUri, destinationPath) {
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
  },
  async stat(path) {
    const file = await ReactNativeBlobUtil.fs.stat(path);
    return { sizeBytes: Number(file.size) };
  },
  exists: path => ReactNativeBlobUtil.fs.exists(path),
  remove: async path => {
    if (await ReactNativeBlobUtil.fs.exists(path)) {
      await ReactNativeBlobUtil.fs.unlink(path);
    }
  },
  async listTemporaryFiles() {
    if (!(await ReactNativeBlobUtil.fs.exists(temporaryDirectory))) {
      return [];
    }
    return (await ReactNativeBlobUtil.fs.ls(temporaryDirectory)).map(
      name => `${temporaryDirectory}/${name}`,
    );
  },
};

const defaultDependencies: ImageProcessingDependencies = {
  fileSystem: defaultFileSystem,
  getDimensions: uri =>
    new Promise((resolve, reject) => {
      Image.getSize(
        uri,
        (width, height) => resolve({ width, height }),
        error => reject(new Error(`The image could not be decoded: ${error}`)),
      );
    }),
  async resize(uri, maxDimension, format, quality, outputDirectory) {
    const resized = await ImageResizer.createResizedImage(
      uri,
      maxDimension,
      maxDimension,
      format,
      quality,
      0,
      outputDirectory,
      false,
      { mode: 'contain', onlyScaleDown: true },
    );
    return { path: resized.path, name: resized.name };
  },
  createId: createLocalUuid,
  platform: Platform.OS,
};

export class ImageProcessingService {
  constructor(
    private readonly dependencies: ImageProcessingDependencies =
      defaultDependencies,
  ) {}

  async processAndUse<T>(
    inputs: readonly LocalImageInput[],
    persistProcessedImages: (
      images: readonly ProcessedReportImage[],
    ) => Promise<T>,
    onProgress: (progress: ImageProcessingProgress) => void,
  ): Promise<T> {
    const processed: ProcessedReportImage[] = [];
    let operationError: unknown;
    let outcome: { result: T } | undefined;

    try {
      for (let index = 0; index < inputs.length; index += 1) {
        processed.push(
          await this.processOne(
            inputs[index],
            index,
            inputs.length,
            onProgress,
          ),
        );
        onProgress({ completed: index + 1, total: inputs.length });
      }
      outcome = { result: await persistProcessedImages(processed) };
    } catch (error) {
      operationError = error;
    }

    const cleanupError = await this.cleanupFiles();
    if (cleanupError) {
      if (__DEV__) {
        console.warn(
          '[image-processing] Temporary image cleanup failed',
          cleanupError,
          operationError,
        );
      }
      throw new Error(
        'Temporary image cleanup failed. Restart the app before trying again.',
      );
    }
    if (operationError) {
      throw operationError;
    }
    if (!outcome) {
      throw new Error('Image processing did not produce a result.');
    }
    return outcome.result;
  }

  async cleanupTemporaryFiles(): Promise<void> {
    const error = await this.cleanupFiles();
    if (error) {
      if (__DEV__) {
        console.warn('[image-processing] Startup cleanup failed', error);
      }
      throw new Error(
        'Temporary image files could not be cleaned. Restart the app before trying again.',
      );
    }
  }

  private async processOne(
    input: LocalImageInput,
    index: number,
    total: number,
    onProgress: (progress: ImageProcessingProgress) => void,
  ): Promise<ProcessedReportImage> {
    const mimeType = normalizedMimeType(input.mimeType);
    if (!isSupportedImageMimeType(mimeType)) {
      throw new Error(
        'Unsupported image format. Choose a JPEG, PNG, or WebP image.',
      );
    }
    if (mimeType === 'image/webp' && this.dependencies.platform !== 'android') {
      throw new Error(
        'WebP processing is only supported on Android. Choose a JPEG or PNG image.',
      );
    }
    if (
      !input.uri.startsWith('content://') &&
      !input.uri.startsWith('file://') &&
      !input.uri.startsWith('/')
    ) {
      throw new Error('The selected image does not have a valid local URI.');
    }

    const extension = extensionForMimeType(mimeType);
    const sourcePath = `${this.dependencies.fileSystem.temporaryDirectory()}/${this.dependencies.createId()}.${extension}`;
    try {
      await this.dependencies.fileSystem.ensureTemporaryDirectory();
      await this.dependencies.fileSystem.copyToTemporary(input.uri, sourcePath);
      const sourceInfo = await this.dependencies.fileSystem.stat(sourcePath);
      if (!Number.isSafeInteger(sourceInfo.sizeBytes) || sourceInfo.sizeBytes < 1) {
        throw new Error('The selected image is empty or has an invalid size.');
      }

      const dimensions = await this.dependencies.getDimensions(
        toFileUri(sourcePath),
      );
      if (
        !Number.isSafeInteger(dimensions.width) ||
        !Number.isSafeInteger(dimensions.height) ||
        dimensions.width < 1 ||
        dimensions.height < 1
      ) {
        throw new Error('The selected image has invalid dimensions.');
      }

      if (
        sourceInfo.sizeBytes < MAX_IMAGE_SIZE_BYTES &&
        Math.max(dimensions.width, dimensions.height) <= MAX_IMAGE_DIMENSION
      ) {
        return {
          ...input,
          uri: sourcePath,
          mimeType,
          sizeBytes: sourceInfo.sizeBytes,
        };
      }

      return await this.resizeUntilWithinLimit({
        input,
        sourcePath,
        sourceDimensions: dimensions,
        mimeType,
        total,
        index,
        onProgress,
      });
    } catch (error) {
      if (__DEV__) {
        console.warn('[image-processing] Unable to process selected image', error);
      }
      if (error instanceof ImageUriCopyError) {
        throw new Error(`${displayName(input, index)}: ${error.message}`);
      }
      throw new Error(
        `${displayName(input, index)}: ${readableProcessingError(error)}`,
      );
    }
  }

  private async resizeUntilWithinLimit(options: {
    input: LocalImageInput;
    sourcePath: string;
    sourceDimensions: ImageDimensions;
    mimeType: SupportedImageMimeType;
    total: number;
    index: number;
    onProgress: (progress: ImageProcessingProgress) => void;
  }): Promise<ProcessedReportImage> {
    const {
      input,
      sourcePath,
      sourceDimensions,
      mimeType,
      total,
      index,
      onProgress,
    } = options;
    const format = formatForMimeType(mimeType);
    const dimensions = dimensionSteps(
      Math.max(sourceDimensions.width, sourceDimensions.height),
    );
    let attempt = 0;

    for (let dimensionIndex = 0; dimensionIndex < dimensions.length; dimensionIndex += 1) {
      const maxDimension = dimensions[dimensionIndex];
      const qualities =
        mimeType === 'image/png'
          ? [100]
          : dimensionIndex === 0
            ? [...qualitySteps]
            : [dimensionIndex <= 4 ? 70 : 55];
      for (const quality of qualities) {
        attempt += 1;
        onProgress({ completed: index, total });
        const resized = await this.dependencies.resize(
          toFileUri(sourcePath),
          maxDimension,
          format,
          quality,
          this.dependencies.fileSystem.temporaryDirectory(),
        );
        const exists = await this.dependencies.fileSystem.exists(resized.path);
        if (!exists) {
          throw new Error('The image processor did not create an output file.');
        }
        const outputInfo = await this.dependencies.fileSystem.stat(resized.path);
        if (
          !Number.isSafeInteger(outputInfo.sizeBytes) ||
          outputInfo.sizeBytes < 1
        ) {
          await this.dependencies.fileSystem.remove(resized.path);
          throw new Error('The processed image is empty or invalid.');
        }
        if (!extensionMatchesMimeType(resized.name, mimeType)) {
          await this.dependencies.fileSystem.remove(resized.path);
          throw new Error(
            'The processed image format did not match its MIME type.',
          );
        }
        if (outputInfo.sizeBytes < MAX_IMAGE_SIZE_BYTES) {
          return {
            ...input,
            uri: resized.path,
            mimeType,
            sizeBytes: outputInfo.sizeBytes,
          };
        }
        await this.dependencies.fileSystem.remove(resized.path);
      }
    }

    throw new Error(
      `This image is still 5 MiB or larger after ${attempt} compression attempts. Choose a smaller image.`,
    );
  }

  private async cleanupFiles(): Promise<unknown | null> {
    try {
      const files = await this.dependencies.fileSystem.listTemporaryFiles();
      const results = await Promise.all(
        files.map(async file => {
          try {
            await this.dependencies.fileSystem.remove(file);
            return null;
          } catch (error) {
            return error;
          }
        }),
      );
      return results.find(error => error !== null) ?? null;
    } catch (error) {
      return error;
    }
  }
}

function normalizedMimeType(mimeType: string): string {
  return mimeType.trim().toLowerCase().split(';')[0];
}

function extensionForMimeType(mimeType: SupportedImageMimeType): string {
  switch (mimeType) {
    case 'image/jpeg':
      return 'jpg';
    case 'image/png':
      return 'png';
    case 'image/webp':
      return 'webp';
  }
}

function formatForMimeType(mimeType: SupportedImageMimeType): ResizeFormat {
  switch (mimeType) {
    case 'image/jpeg':
      return 'JPEG';
    case 'image/png':
      return 'PNG';
    case 'image/webp':
      return 'WEBP';
  }
}

function extensionMatchesMimeType(
  fileName: string,
  mimeType: SupportedImageMimeType,
): boolean {
  const extension = fileName.toLowerCase().split('.').pop();
  return mimeType === 'image/jpeg'
    ? extension === 'jpg' || extension === 'jpeg'
    : mimeType === 'image/png'
      ? extension === 'png'
      : extension === 'webp';
}

function dimensionSteps(sourceDimension: number): number[] {
  const steps: number[] = [];
  let current = Math.min(sourceDimension, MAX_IMAGE_DIMENSION);
  while (current >= minimumDimension) {
    steps.push(current);
    const next = Math.floor(current * 0.8);
    if (next >= current) {
      break;
    }
    current = next;
  }
  if (steps[steps.length - 1] !== minimumDimension) {
    steps.push(minimumDimension);
  }
  return [...new Set(steps)];
}

function toFileUri(path: string): string {
  return path.startsWith('file://') ? path : `file://${path}`;
}

function displayName(input: LocalImageInput, index: number): string {
  return input.originalFileName?.trim() || `Image ${index + 1}`;
}

function readableProcessingError(error: unknown): string {
  const message = messageOf(error);
  if (/could not be decoded|decode|corrupt|invalid image/i.test(message)) {
    return 'This image is corrupt or cannot be decoded. Choose another image.';
  }
  if (
    /still 5 MiB or larger|empty or has an invalid size|invalid dimensions|processor did not create|processed image is empty|format did not match/i.test(
      message,
    )
  ) {
    return message;
  }
  return 'This image could not be processed. Choose another image and try again.';
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
