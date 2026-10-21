export const DEFAULT_TIMEOUT_MS = 5000;
export const DEFAULT_RETRIES = 1;

export class HttpError extends Error {
  readonly status: number;
  readonly url: string;

  constructor(status: number, url: string) {
    super(`Request failed with status ${status}`);
    this.name = 'HttpError';
    this.status = status;
    this.url = url;
  }
}

export const isAbortError = (error: unknown): boolean =>
  error instanceof DOMException && error.name === 'AbortError';

const wait = (ms: number, signal: AbortSignal): Promise<void> => new Promise((resolve, reject) => {
  const timer = setTimeout(resolve, ms);
  const abort = () => {
    clearTimeout(timer);
    reject(new DOMException('The operation was aborted.', 'AbortError'));
  };
  if (signal.aborted) {
    abort();
    return;
  }
  signal.addEventListener('abort', abort, { once: true });
});

export async function fetchWithTimeout(
  url: string,
  options: RequestInit = {},
  timeoutMs = DEFAULT_TIMEOUT_MS,
  retries = DEFAULT_RETRIES,
): Promise<Response> {
  if (options.signal?.aborted) {
    throw new DOMException('The operation was aborted.', 'AbortError');
  }

  let lastError: unknown;

  for (let attempt = 0; attempt <= retries; attempt++) {
    const controller = new AbortController();
    const callerSignal = options.signal;
    const onAbort = () => controller.abort();
    callerSignal?.addEventListener('abort', onAbort, { once: true });
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const response = await fetch(url, { ...options, signal: controller.signal });
      if (response.ok || response.status < 500 || attempt === retries) return response;
      lastError = new HttpError(response.status, url);
    } catch (error) {
      lastError = error;
      if (
        callerSignal?.aborted ||
        (isAbortError(error) && controller.signal.aborted && timeoutMs <= 0)
      ) {
        throw error;
      }
    } finally {
      clearTimeout(timer);
      callerSignal?.removeEventListener('abort', onAbort);
    }

    if (attempt < retries) {
      const backoff = 100 * (attempt + 1);
      await wait(backoff, callerSignal ?? new AbortController().signal);
    }
  }

  throw lastError instanceof Error ? lastError : new Error('Request failed');
}

export async function fetchJson<T>(
  url: string,
  options: RequestInit = {},
  timeoutMs = DEFAULT_TIMEOUT_MS,
  retries = DEFAULT_RETRIES,
): Promise<T> {
  const response = await fetchWithTimeout(url, options, timeoutMs, retries);
  if (!response.ok) throw new HttpError(response.status, url);
  return response.json() as Promise<T>;
}
