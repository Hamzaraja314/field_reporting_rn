export const MAX_REPORT_IMAGES = 5;
export const MAX_IMAGE_SIZE_BYTES = 5 * 1024 * 1024;
export const MAX_IMAGE_DIMENSION = 2048;

export const supportedImageMimeTypes = [
  'image/jpeg',
  'image/png',
  'image/webp',
] as const;

export type SupportedImageMimeType =
  (typeof supportedImageMimeTypes)[number];

export function isSupportedImageMimeType(
  mimeType: string,
): mimeType is SupportedImageMimeType {
  return supportedImageMimeTypes.includes(
    mimeType.toLowerCase() as SupportedImageMimeType,
  );
}
