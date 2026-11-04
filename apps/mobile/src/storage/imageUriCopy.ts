export interface ImageUriCopyOperations {
  copyFile(sourcePath: string, destinationPath: string): Promise<unknown>;
  copyContentUri(sourceUri: string, destinationPath: string): Promise<unknown>;
  exists(path: string): Promise<boolean>;
  remove(path: string): Promise<void>;
}

export class ImageUriCopyError extends Error {
  constructor(
    message: string,
    readonly kind: 'source-unavailable' | 'copy-failed' | 'destination-missing',
  ) {
    super(message);
    this.name = 'ImageUriCopyError';
  }
}

export async function copyImageUriToPath(
  sourceUri: string,
  destinationPath: string,
  operations: ImageUriCopyOperations,
): Promise<void> {
  const isContentUri = sourceUri.startsWith('content://');
  let sourcePath: string | null = null;
  if (!isContentUri) {
    sourcePath = filePathFromUri(sourceUri);
    if (!(await operations.exists(sourcePath))) {
      throw new ImageUriCopyError(
        'The selected image is no longer available. Select it again.',
        'source-unavailable',
      );
    }
  }

  try {
    if (isContentUri) {
      await operations.copyContentUri(sourceUri, destinationPath);
    } else {
      await operations.copyFile(sourcePath!, destinationPath);
    }
    if (!(await operations.exists(destinationPath))) {
      throw new ImageUriCopyError(
        'The image could not be saved to app storage. Check available space and retry.',
        'destination-missing',
      );
    }
  } catch (error) {
    if (__DEV__) {
      console.warn('[image-copy] Native image copy failed', error);
    }
    let cleanupError: unknown;
    try {
      if (await operations.exists(destinationPath)) {
        await operations.remove(destinationPath);
      }
    } catch (failure) {
      cleanupError = failure;
    }
    if (cleanupError) {
      throw new Error(
        `Image copy failed and its partial destination could not be removed: ${messageOf(cleanupError)} (copy error: ${messageOf(error)})`,
      );
    }
    if (error instanceof ImageUriCopyError) {
      throw error;
    }
    throw new ImageUriCopyError(
      isContentUri
        ? 'The selected image could not be read. Select it again and retry.'
        : 'The selected image could not be copied. Select it again and retry.',
      'copy-failed',
    );
  }
}

export function filePathFromUri(uri: string): string {
  if (uri.startsWith('file://')) {
    const path = uri.slice('file://'.length);
    if (!path.startsWith('/')) {
      throw new ImageUriCopyError(
        'The selected image does not have a valid local URI.',
        'source-unavailable',
      );
    }
    try {
      return decodeURIComponent(path);
    } catch {
      throw new ImageUriCopyError(
        'The selected image does not have a valid local URI.',
        'source-unavailable',
      );
    }
  }
  if (uri.startsWith('/')) {
    return uri;
  }
  throw new ImageUriCopyError(
    'The selected image does not have a supported local URI.',
    'source-unavailable',
  );
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
