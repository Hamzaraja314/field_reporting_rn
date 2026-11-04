import {
  launchCamera,
  launchImageLibrary,
  type Asset,
  type ImagePickerResponse,
} from 'react-native-image-picker';
import { PermissionsAndroid, Platform } from 'react-native';
import { MAX_REPORT_IMAGES } from './imageLimits';

export interface SelectedReportImage {
  uri: string;
  mimeType?: string;
  fileName?: string;
}

export type ImageSelection =
  | { kind: 'selected'; images: SelectedReportImage[] }
  | { kind: 'cancelled' }
  | { kind: 'permission-denied' }
  | { kind: 'error'; message: string };

export interface ReportImagePickerDependencies {
  launchCamera: typeof launchCamera;
  launchImageLibrary: typeof launchImageLibrary;
  requestCameraPermission: () => Promise<boolean>;
}

const defaultDependencies: ReportImagePickerDependencies = {
  launchCamera,
  launchImageLibrary,
  requestCameraPermission: async () => {
    if (Platform.OS !== 'android') {
      return true;
    }

    const permission = PermissionsAndroid.PERMISSIONS.CAMERA;
    if (await PermissionsAndroid.check(permission)) {
      return true;
    }
    const result = await PermissionsAndroid.request(permission, {
      title: 'Camera permission',
      message: 'Allow Field Reporting to take report photos.',
      buttonPositive: 'Continue',
      buttonNegative: 'Not now',
    });
    return result === PermissionsAndroid.RESULTS.GRANTED;
  },
};

export class ReportImagePicker {
  constructor(
    private readonly dependencies: ReportImagePickerDependencies =
      defaultDependencies,
  ) {}

  async takePhoto(): Promise<ImageSelection> {
    try {
      if (!(await this.dependencies.requestCameraPermission())) {
        return { kind: 'permission-denied' };
      }
      return mapPickerResponse(
        await this.dependencies.launchCamera({
          mediaType: 'photo',
          includeBase64: false,
          includeExtra: false,
          saveToPhotos: false,
        }),
      );
    } catch (error) {
      return { kind: 'error', message: messageOf(error) };
    }
  }

  async chooseFromGallery(remaining: number): Promise<ImageSelection> {
    if (!Number.isInteger(remaining) || remaining < 1) {
      return {
        kind: 'error',
        message: 'This report already has the maximum of five images.',
      };
    }
    try {
      return mapPickerResponse(
        await this.dependencies.launchImageLibrary({
          mediaType: 'photo',
          selectionLimit: Math.min(remaining, MAX_REPORT_IMAGES),
          includeBase64: false,
          includeExtra: false,
          restrictMimeTypes: ['image/jpeg', 'image/png', 'image/webp'],
        }),
      );
    } catch (error) {
      return { kind: 'error', message: messageOf(error) };
    }
  }
}

function mapPickerResponse(response: ImagePickerResponse): ImageSelection {
  if (response.didCancel) {
    return { kind: 'cancelled' };
  }
  if (response.errorCode === 'permission') {
    return { kind: 'permission-denied' };
  }
  if (response.errorCode) {
    return {
      kind: 'error',
      message: response.errorMessage || 'The image picker could not be opened.',
    };
  }

  const images = (response.assets ?? [])
    .filter((asset): asset is Asset & { uri: string } => Boolean(asset.uri))
    .map(asset => ({
      uri: asset.uri,
      mimeType: asset.type ?? mimeTypeFromFileName(asset.fileName),
      fileName: asset.fileName,
    }));
  return images.length > 0
    ? { kind: 'selected', images }
    : { kind: 'cancelled' };
}

function mimeTypeFromFileName(fileName?: string): string | undefined {
  const extension = fileName?.toLowerCase().split('.').pop();
  switch (extension) {
    case 'jpg':
    case 'jpeg':
      return 'image/jpeg';
    case 'png':
      return 'image/png';
    case 'webp':
      return 'image/webp';
    default:
      return undefined;
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
