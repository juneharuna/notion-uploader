export interface RetryOptions {
  maxRetries: number;
  baseDelayMs: number;
  maxDelayMs: number;
  retryableStatuses: number[];
}

const DEFAULT_OPTIONS: RetryOptions = {
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

  // Try parsing as seconds
  const seconds = Number(retryAfter);
  if (!isNaN(seconds)) {
    return seconds * 1000;
  }

  // Try parsing as HTTP date
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

export async function fetchWithRetry(
  url: string,
  init: RequestInit,
  options?: Partial<RetryOptions>
): Promise<Response> {
  const opts = { ...DEFAULT_OPTIONS, ...options };
  let lastError: Error | null = null;

  for (let attempt = 0; attempt <= opts.maxRetries; attempt++) {
    try {
      const response = await fetch(url, init);

      if (response.ok) {
        return response;
      }

      // Non-retryable status codes: return immediately
      if (!opts.retryableStatuses.includes(response.status)) {
        return response;
      }

      // Last attempt: throw
      if (attempt === opts.maxRetries) {
        throw new Error(
          `Request failed after ${opts.maxRetries} retries: ${response.status}`
        );
      }

      // Calculate delay
      let delay = getDelay(attempt, opts.baseDelayMs, opts.maxDelayMs);

      // For 429, use Retry-After as minimum delay
      if (response.status === 429) {
        const retryAfterMs = parseRetryAfter(response);
        if (retryAfterMs !== null) {
          delay = Math.max(delay, retryAfterMs);
        }
      }

      await sleep(delay);
    } catch (error) {
      // Network errors (TypeError: Failed to fetch) are retryable
      if (error instanceof TypeError) {
        lastError = error;
        if (attempt === opts.maxRetries) {
          throw error;
        }
        const delay = getDelay(attempt, opts.baseDelayMs, opts.maxDelayMs);
        await sleep(delay);
        continue;
      }

      // Re-throw non-network errors (including our own "Request failed" error)
      throw error;
    }
  }

  // Should not reach here, but just in case
  throw lastError || new Error("Request failed after retries");
}
