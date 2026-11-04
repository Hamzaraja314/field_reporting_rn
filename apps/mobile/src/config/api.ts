import { Platform } from 'react-native';

let warnedAboutAndroidFallback = false;
let loggedSelectedApiBaseUrl = false;

declare global {
  var __FIELD_REPORTING_API_BASE_URL__: string | undefined;
  var __FIELD_REPORTING_DEV_FAILURE__:
    | 'latency'
    | 'refuse'
    | 'drop'
    | 'hang'
    | 'after-commit-drop'
    | undefined;
}

export function consumeDevFailureScenario(): string | null {
  if (!__DEV__) {
    return null;
  }
  const scenario = globalThis.__FIELD_REPORTING_DEV_FAILURE__;
  globalThis.__FIELD_REPORTING_DEV_FAILURE__ = undefined;
  return scenario ?? null;
}

export function getApiBaseUrl(): string {
  const configuredUrl = globalThis.__FIELD_REPORTING_API_BASE_URL__;
  if (configuredUrl?.trim()) {
    const trimmedUrl = configuredUrl.trim().replace(/\/+$/, '');
    const urlMatch = /^(https?):\/\/([^\s/?#]+)([^?#]*)$/i.exec(trimmedUrl);
    if (!urlMatch || urlMatch[2].includes('@')) {
      throw new Error(
        'FIELD_REPORTING_API_BASE_URL must be an absolute HTTP(S) URL without credentials, query, or fragment.',
      );
    }
    if (!__DEV__ && urlMatch[1]?.toLowerCase() !== 'https') {
      throw new Error('Release API base URLs must use HTTPS.');
    }
    const basePath = urlMatch[3] ?? '';
    const normalizedPath = /(?:\/api\/v1)+$/i.test(basePath)
      ? basePath.replace(/(?:\/api\/v1)+$/i, '/api/v1')
      : `${basePath}/api/v1`;
    const normalizedUrl = `${urlMatch[1]?.toLowerCase()}://${urlMatch[2]}${normalizedPath}`;
    logSelectedApiBaseUrl(normalizedUrl);
    return normalizedUrl;
  }

  if (__DEV__) {
    const fallbackUrl =
      Platform.OS === 'android'
        ? 'https://classic-plate-experienced-mag.trycloudflare.com/api/v1'
        : 'http://localhost:3000/api/v1';
    logSelectedApiBaseUrl(fallbackUrl);
    if (
      Platform.OS === 'android' &&
      !warnedAboutAndroidFallback
    ) {
      warnedAboutAndroidFallback = true;
      console.warn(
        '[ReportUpload] Using the default Android development API URL. Set FIELD_REPORTING_API_BASE_URL to override it.',
      );
    }
    return fallbackUrl;
  }

  throw new Error(
    'Set __FIELD_REPORTING_API_BASE_URL__ to the deployed /api/v1 URL before uploading in a release build.',
  );
}

function logSelectedApiBaseUrl(url: string): void {
  if (__DEV__ && !loggedSelectedApiBaseUrl) {
    loggedSelectedApiBaseUrl = true;
    console.info(`[ReportUpload] Selected API base URL: ${url}`);
  }
}
