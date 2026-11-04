import type { LocalReport, LocalReportImage } from './model';
import type { ReportResponse } from '../../../../packages/types/src';
import {
  consumeDevFailureScenario,
  getApiBaseUrl,
} from '../config/api';

const REQUEST_TIMEOUT_MS = 180_000;

interface NativeFilePart {
  uri: string;
  type: string;
  name: string;
}

interface UploadFormData {
  append(name: string, value: string | NativeFilePart): void;
  toBody(): FormData;
}

interface UploadResponse {
  status: number;
  headers: { get(name: string): string | null };
  json(): Promise<unknown>;
  text?(): Promise<string>;
}

interface UploadRequestInit {
  method: 'POST';
  headers: Record<string, string>;
  body: FormData;
  signal: AbortSignal;
}

type UploadFetch = (
  url: string,
  init: UploadRequestInit,
) => Promise<UploadResponse>;

export class ReportUploadError extends Error {
  constructor(
    message: string,
    readonly retryable: boolean,
    readonly retryAfterMs: number | null = null,
    readonly classification: string | null = null,
  ) {
    super(message);
    this.name = 'ReportUploadError';
  }
}

export class ReportUploadClient {
  constructor(
    private readonly fetchRequest: UploadFetch = nativeFetch,
    private readonly formDataFactory: () => UploadFormData = nativeFormData,
    private readonly apiBaseUrl: () => string = getApiBaseUrl,
    private readonly timeoutMs = REQUEST_TIMEOUT_MS,
    private readonly now: () => number = Date.now,
  ) {}

  async upload(report: LocalReport): Promise<ReportResponse> {
    const formData = this.formDataFactory();
    formData.append('description', report.description.trim());
    const images = [...report.images].sort(
      (left, right) => left.orderIndex - right.orderIndex,
    );
    for (const [index, image] of images.entries()) {
      formData.append('images', nativeFilePart(image, index));
    }

    const headers: Record<string, string> = {
      'Idempotency-Key': report.idempotencyKey,
    };
    const devFailure = consumeDevFailureScenario();
    if (devFailure) {
      headers['x-dev-failure'] = devFailure;
    }

    let apiBaseUrl: string;
    try {
      apiBaseUrl = this.apiBaseUrl();
    } catch (error) {
      throw new ReportUploadError(errorMessage(error), false);
    }

    const controller = new AbortController();
    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, this.timeoutMs);
    const requestStartedAt = Date.now();
    const safeEndpoint = sanitizeEndpoint(
      `${apiBaseUrl.replace(/\/+$/, '')}/reports`,
    );
    logDiagnostic('info', 'request started', {
      reportId: report.localId,
      method: 'POST',
      endpoint: safeEndpoint,
      startedAt: new Date(requestStartedAt).toISOString(),
      imageCount: images.length,
      totalImageBytes: images.reduce((total, image) => total + image.sizeBytes, 0),
    });
    try {
      let response: UploadResponse;
      try {
        response = await this.fetchRequest(
          `${apiBaseUrl.replace(/\/+$/, '')}/reports`,
          {
            method: 'POST',
            headers,
            body: formData.toBody(),
            signal: controller.signal,
          },
        );
      } catch (error) {
        const failure = networkError(timedOut, error);
        logDiagnostic('warn', 'request failed', {
          reportId: report.localId,
          method: 'POST',
          endpoint: safeEndpoint,
          completedAt: new Date().toISOString(),
          durationMs: Date.now() - requestStartedAt,
          timedOut,
          classification: failure.classification,
          ...nativeErrorDetails(error),
        });
        throw failure;
      }

      if (response.status < 200 || response.status >= 300) {
        const retryable =
          response.status === 408 ||
          response.status === 429 ||
          [500, 502, 503, 504].includes(response.status);
        const responseBody = await readResponseBody(response);
        const retryAfterMs = retryable
          ? retryAfterMilliseconds(
              response.headers.get('Retry-After'),
              this.now(),
            )
          : null;
        logDiagnostic(retryable ? 'warn' : 'error', 'response rejected', {
          reportId: report.localId,
          method: 'POST',
          endpoint: safeEndpoint,
          completedAt: new Date().toISOString(),
          durationMs: Date.now() - requestStartedAt,
          status: response.status,
          imageCount: images.length,
          totalImageBytes: images.reduce(
            (total, image) => total + image.sizeBytes,
            0,
          ),
          retryable,
          retryAfterMs,
          responseBody,
        });
        throw new ReportUploadError(
          retryable
            ? `The server returned ${response.status}. The report will be retried.`
            : `The server rejected this report (${response.status}). Review the report and retry it.`,
          retryable,
          retryAfterMs,
          `http_${response.status}`,
        );
      }

      let body: unknown;
      try {
        body = await response.json();
      } catch (error) {
        if (timedOut) {
          const failure = networkError(true, error);
          logDiagnostic('warn', 'response read failed', {
            reportId: report.localId,
            method: 'POST',
            endpoint: safeEndpoint,
            completedAt: new Date().toISOString(),
            durationMs: Date.now() - requestStartedAt,
            status: response.status,
            timedOut: true,
            classification: failure.classification,
            ...nativeErrorDetails(error),
          });
          throw failure;
        }
        logDiagnostic('warn', 'invalid success response', {
          reportId: report.localId,
          method: 'POST',
          endpoint: safeEndpoint,
          completedAt: new Date().toISOString(),
          durationMs: Date.now() - requestStartedAt,
          status: response.status,
          parseError: redactSensitiveText(errorMessage(error)),
        });
        throw invalidResponse();
      }
      try {
        const result = validateResponse(body, report);
        logDiagnostic('info', 'request completed', {
          reportId: report.localId,
          method: 'POST',
          endpoint: safeEndpoint,
          completedAt: new Date().toISOString(),
          durationMs: Date.now() - requestStartedAt,
          status: response.status,
        });
        return result;
      } catch (error) {
        logDiagnostic('warn', 'invalid success response', {
          reportId: report.localId,
          method: 'POST',
          endpoint: safeEndpoint,
          completedAt: new Date().toISOString(),
          durationMs: Date.now() - requestStartedAt,
          status: response.status,
          classification: 'malformed_success_response',
        });
        throw error;
      }
    } finally {
      clearTimeout(timeout);
    }
  }
}

function nativeFetch(url: string, init: UploadRequestInit): Promise<UploadResponse> {
  return fetch(url, init);
}

function nativeFormData(): UploadFormData {
  const formData = new FormData();
  return {
    append(name, value) {
      if (typeof value === 'string') {
        formData.append(name, value);
      } else {
        // React Native FormData accepts this URI-based file descriptor.
        formData.append(name, value as unknown as Blob);
      }
    },
    toBody: () => formData,
  };
}

function nativeFilePart(
  image: LocalReportImage,
  index: number,
): NativeFilePart {
  const extension =
    image.mimeType === 'image/jpeg'
      ? 'jpg'
      : image.mimeType === 'image/png'
        ? 'png'
        : image.mimeType === 'image/webp'
          ? 'webp'
          : null;
  if (!extension) {
    throw new ReportUploadError(
      'An attached image has an unsupported format and cannot be uploaded.',
      false,
    );
  }
  const untrustedName = image.originalFileName?.replace(/^.*[\\/]/, '');
  const baseName = untrustedName
    ? [...untrustedName]
        .filter(character => {
          const code = character.charCodeAt(0);
          return code >= 32 && code !== 127;
        })
        .join('')
        .trim()
    : '';
  const name = baseName && baseName.toLowerCase().endsWith(`.${extension}`)
    ? baseName
    : `image-${index + 1}.${extension}`;
  const uri = image.filePath.startsWith('file://')
    ? image.filePath
    : `file://${image.filePath}`;
  return { uri, type: image.mimeType, name };
}

function validateResponse(
  value: unknown,
  report: LocalReport,
): ReportResponse {
  if (!isRecord(value)) {
    throw invalidResponse();
  }
  const response = value as Partial<ReportResponse>;
  const images = [...report.images].sort(
    (left, right) => left.orderIndex - right.orderIndex,
  );
  if (
    typeof response.id !== 'string' ||
    !response.id.trim() ||
    response.description !== report.description.trim() ||
    typeof response.createdAt !== 'string' ||
    !Number.isFinite(Date.parse(response.createdAt)) ||
    !Array.isArray(response.images) ||
    response.images.length !== images.length
  ) {
    throw invalidResponse();
  }
  const allImagesMatch = response.images.every((image, index) => {
    const localImage = images[index];
    return (
      isRecord(image) &&
      image.orderIndex === localImage.orderIndex &&
      image.mimeType === localImage.mimeType &&
      image.sizeBytes === localImage.sizeBytes &&
      typeof image.id === 'string' &&
      image.id.length > 0 &&
      typeof image.url === 'string' &&
      image.url.length > 0
    );
  });
  if (!allImagesMatch) {
    throw invalidResponse();
  }
  return response as ReportResponse;
}

function invalidResponse(): ReportUploadError {
  return new ReportUploadError(
    'The server response did not match this report. Retrying safely with the same idempotency key.',
    true,
  );
}

function networkError(
  timedOut: boolean,
  error?: unknown,
): ReportUploadError {
  const classification = classifyNetworkFailure(timedOut, error);
  const messages: Record<string, string> = {
    timeout: 'The upload timed out. It will be retried automatically.',
    dns: 'The API host name could not be resolved. Check the API URL and network.',
    connection_refused: 'The API server refused the connection. Check that it is running at the configured address and port.',
    connection_reset: 'The connection to the API was dropped. The report will be retried.',
    cleartext_blocked: 'Android blocked this HTTP connection. Use HTTPS or the debug network policy.',
    unreachable: 'The API server could not be reached. The report will be retried when connectivity is available.',
  };
  return new ReportUploadError(
    messages[classification] ?? messages.unreachable!,
    true,
    null,
    classification,
  );
}

function classifyNetworkFailure(
  timedOut: boolean,
  error: unknown,
): string {
  const details = nativeErrorDetails(error);
  const code = details.nativeCode?.toUpperCase() ?? '';
  const message = details.nativeMessage?.toLowerCase() ?? '';
  if (
    timedOut ||
    code.includes('TIMEOUT') ||
    message.includes('timed out') ||
    message.includes('timeout')
  ) {
    return 'timeout';
  }
  if (
    code.includes('ENOTFOUND') ||
    code.includes('EAI_AGAIN') ||
    message.includes('unknown host') ||
    message.includes('unable to resolve')
  ) {
    return 'dns';
  }
  if (code.includes('ECONNREFUSED') || message.includes('connection refused')) {
    return 'connection_refused';
  }
  if (
    code.includes('ECONNRESET') ||
    message.includes('connection reset') ||
    message.includes('connection was aborted')
  ) {
    return 'connection_reset';
  }
  if (
    message.includes('cleartext http traffic') ||
    message.includes('not permitted')
  ) {
    return 'cleartext_blocked';
  }
  return 'unreachable';
}

function nativeErrorDetails(error: unknown): {
  nativeCode: string | null;
  nativeMessage: string | null;
} {
  if (!isRecord(error)) {
    return {
      nativeCode: null,
      nativeMessage: error === undefined
        ? null
        : redactSensitiveText(String(error)),
    };
  }
  const cause = isRecord(error.cause) ? error.cause : null;
  const code = error.code ?? cause?.code;
  const message = error.message ?? cause?.message;
  return {
    nativeCode:
      typeof code === 'string' ? code.slice(0, 80) : null,
    nativeMessage:
      typeof message === 'string'
        ? redactSensitiveText(message)
        : null,
  };
}

async function readResponseBody(response: UploadResponse): Promise<string | null> {
  if (!response.text) {
    return null;
  }
  try {
    return redactSensitiveText(await response.text());
  } catch (error) {
    logDiagnostic('warn', 'response body unavailable', {
      error: redactSensitiveText(errorMessage(error)),
    });
    return null;
  }
}

function sanitizeEndpoint(endpoint: string): string {
  try {
    const url = new URL(endpoint);
    return redactSensitiveText(`${url.origin}${url.pathname}`);
  } catch {
    return redactSensitiveText(endpoint.split(/[?#]/, 1)[0] ?? endpoint);
  }
}

function redactSensitiveText(value: string): string {
  return value
    .replace(/Bearer\s+[^\s,;]+/gi, 'Bearer [redacted]')
    .replace(
      /(["']?(?:authorization|token|password|secret|api[_-]?key|email|phone)["']?\s*[:=]\s*)("[^"]*"|'[^']*'|[^,\s}]+)/gi,
      '$1"[redacted]"',
    )
    .replace(
      /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi,
      '[redacted-email]',
    )
    .replace(
      /(^|[\s("'=])(?:file:\/\/)?(?:[A-Za-z]:[\\/]|\/(?:data|storage|private|Users|home)\/)[^\s"'<>]*/gi,
      '$1[redacted-path]',
    )
    .slice(0, 1_000);
}

function logDiagnostic(
  level: 'info' | 'warn' | 'error',
  event: string,
  details: Record<string, unknown>,
): void {
  if (__DEV__) {
    console[level](`[ReportUpload] ${event}`, details);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function retryAfterMilliseconds(
  value: string | null,
  now: number,
): number | null {
  if (!value) {
    return null;
  }
  const seconds = Number(value.trim());
  if (Number.isFinite(seconds) && seconds >= 0) {
    return seconds * 1000;
  }
  const date = Date.parse(value);
  return Number.isFinite(date) ? Math.max(0, date - now) : null;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
