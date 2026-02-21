export interface ClientRetryOptions {
  maxRetries: number;
  baseDelayMs: number;
  maxDelayMs: number;
  retryableStatuses: number[];
  timeoutMs?: number;
}

const DEFAULT_OPTIONS: ClientRetryOptions = {
  maxRetries: 3,
  baseDelayMs: 1000,
  maxDelayMs: 30000,
  retryableStatuses: [429, 500, 502, 503, 504],
};

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function parseRetryAfter(response: Response): number | null {
  const retryAfter = response.headers?.get?.("Retry-After");
  if (!retryAfter) return null;

  const seconds = Number(retryAfter);
  if (!isNaN(seconds)) {
    return seconds * 1000;
  }

  const date = new Date(retryAfter);
  if (!isNaN(date.getTime())) {
    return Math.max(0, date.getTime() - Date.now());
  }

  return null;
}

function getDelay(
  attempt: number,
  baseDelayMs: number,
  maxDelayMs: number
): number {
  const exponential = baseDelayMs * Math.pow(2, attempt);
  const jitter = Math.random() * baseDelayMs;
  return Math.min(exponential + jitter, maxDelayMs);
}

function isRetryableError(error: unknown): boolean {
  if (error instanceof TypeError) return true;
  if (error instanceof DOMException && error.name === "AbortError") return true;
  return false;
}

export async function clientFetchWithRetry(
  url: string,
  init: RequestInit,
  options?: Partial<ClientRetryOptions>
): Promise<Response> {
  const opts = { ...DEFAULT_OPTIONS, ...options };
  let lastError: Error | null = null;

  for (let attempt = 0; attempt <= opts.maxRetries; attempt++) {
    // Set up per-request timeout via AbortController
    let controller: AbortController | undefined;
    let timeoutId: ReturnType<typeof setTimeout> | undefined;

    if (opts.timeoutMs) {
      controller = new AbortController();
      timeoutId = setTimeout(() => controller!.abort(), opts.timeoutMs);
    }

    try {
      const fetchInit = controller
        ? { ...init, signal: controller.signal }
        : init;
      const response = await fetch(url, fetchInit);

      if (response.ok) {
        return response;
      }

      if (!opts.retryableStatuses.includes(response.status)) {
        return response;
      }

      if (attempt === opts.maxRetries) {
        let body = "";
        try {
          body = await response.text();
        } catch {
          // ignore body read errors
        }
        throw new Error(
          `Request failed after ${opts.maxRetries} retries (${response.status}): ${body || "no response body"}`
        );
      }

      let delay = getDelay(attempt, opts.baseDelayMs, opts.maxDelayMs);

      if (response.status === 429) {
        const retryAfterMs = parseRetryAfter(response);
        if (retryAfterMs !== null) {
          delay = Math.max(delay, retryAfterMs);
        }
      }

      await sleep(delay);
    } catch (error) {
      if (isRetryableError(error)) {
        lastError = error as Error;
        if (attempt === opts.maxRetries) {
          throw error;
        }
        const delay = getDelay(attempt, opts.baseDelayMs, opts.maxDelayMs);
        await sleep(delay);
        continue;
      }

      throw error;
    } finally {
      if (timeoutId) clearTimeout(timeoutId);
    }
  }

  throw lastError || new Error("Request failed after retries");
}
