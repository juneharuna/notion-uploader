import { describe, it, expect, vi, beforeEach } from "vitest";
import { fetchWithRetry, type RetryOptions } from "@/lib/retry";

const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

const fastOptions: Partial<RetryOptions> = {
  baseDelayMs: 1,
  maxDelayMs: 10,
};

describe("fetchWithRetry", () => {
  beforeEach(() => {
    mockFetch.mockReset();
  });

  it("should return response on first success", async () => {
    mockFetch.mockResolvedValueOnce({ ok: true, status: 200 });

    const res = await fetchWithRetry("https://api.example.com", {}, fastOptions);

    expect(res.ok).toBe(true);
    expect(mockFetch).toHaveBeenCalledOnce();
  });

  it("should retry on 500 and succeed on second attempt", async () => {
    mockFetch
      .mockResolvedValueOnce({ ok: false, status: 500 })
      .mockResolvedValueOnce({ ok: true, status: 200 });

    const res = await fetchWithRetry(
      "https://api.example.com",
      {},
      { ...fastOptions, maxRetries: 3 }
    );

    expect(res.ok).toBe(true);
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it("should retry on 502, 503, 504", async () => {
    for (const status of [502, 503, 504]) {
      mockFetch.mockReset();
      mockFetch
        .mockResolvedValueOnce({ ok: false, status })
        .mockResolvedValueOnce({ ok: true, status: 200 });

      const res = await fetchWithRetry(
        "https://api.example.com",
        {},
        { ...fastOptions, maxRetries: 3 }
      );

      expect(res.ok).toBe(true);
      expect(mockFetch).toHaveBeenCalledTimes(2);
    }
  });

  it("should handle 429 with Retry-After header (seconds)", async () => {
    const retryAfterResponse = {
      ok: false,
      status: 429,
      headers: new Headers({ "Retry-After": "2" }),
    };
    mockFetch
      .mockResolvedValueOnce(retryAfterResponse)
      .mockResolvedValueOnce({ ok: true, status: 200 });

    const start = Date.now();
    const res = await fetchWithRetry(
      "https://api.example.com",
      {},
      { ...fastOptions, maxRetries: 3 }
    );
    const elapsed = Date.now() - start;

    expect(res.ok).toBe(true);
    expect(mockFetch).toHaveBeenCalledTimes(2);
    // Retry-After of 2 seconds should cause at least ~2000ms delay
    expect(elapsed).toBeGreaterThanOrEqual(1900);
  });

  it("should handle 429 with Retry-After header (HTTP date)", async () => {
    const futureDate = new Date(Date.now() + 1000).toUTCString();
    const retryAfterResponse = {
      ok: false,
      status: 429,
      headers: new Headers({ "Retry-After": futureDate }),
    };
    mockFetch
      .mockResolvedValueOnce(retryAfterResponse)
      .mockResolvedValueOnce({ ok: true, status: 200 });

    const res = await fetchWithRetry(
      "https://api.example.com",
      {},
      { ...fastOptions, maxRetries: 3 }
    );

    expect(res.ok).toBe(true);
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it("should NOT retry on 400 (client error)", async () => {
    mockFetch.mockResolvedValueOnce({ ok: false, status: 400 });

    const res = await fetchWithRetry(
      "https://api.example.com",
      {},
      { ...fastOptions, maxRetries: 3 }
    );

    expect(res.ok).toBe(false);
    expect(res.status).toBe(400);
    expect(mockFetch).toHaveBeenCalledOnce();
  });

  it("should NOT retry on 401", async () => {
    mockFetch.mockResolvedValueOnce({ ok: false, status: 401 });

    const res = await fetchWithRetry(
      "https://api.example.com",
      {},
      { ...fastOptions, maxRetries: 3 }
    );

    expect(res.status).toBe(401);
    expect(mockFetch).toHaveBeenCalledOnce();
  });

  it("should NOT retry on 403", async () => {
    mockFetch.mockResolvedValueOnce({ ok: false, status: 403 });

    const res = await fetchWithRetry(
      "https://api.example.com",
      {},
      fastOptions
    );

    expect(res.status).toBe(403);
    expect(mockFetch).toHaveBeenCalledOnce();
  });

  it("should NOT retry on 404", async () => {
    mockFetch.mockResolvedValueOnce({ ok: false, status: 404 });

    const res = await fetchWithRetry(
      "https://api.example.com",
      {},
      fastOptions
    );

    expect(res.status).toBe(404);
    expect(mockFetch).toHaveBeenCalledOnce();
  });

  it("should retry on network error (TypeError)", async () => {
    mockFetch
      .mockRejectedValueOnce(new TypeError("Failed to fetch"))
      .mockResolvedValueOnce({ ok: true, status: 200 });

    const res = await fetchWithRetry(
      "https://api.example.com",
      {},
      { ...fastOptions, maxRetries: 3 }
    );

    expect(res.ok).toBe(true);
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it("should throw after max retries exhausted", async () => {
    mockFetch
      .mockResolvedValueOnce({ ok: false, status: 500 })
      .mockResolvedValueOnce({ ok: false, status: 500 })
      .mockResolvedValueOnce({ ok: false, status: 500 })
      .mockResolvedValueOnce({ ok: false, status: 500 });

    await expect(
      fetchWithRetry("https://api.example.com", {}, {
        ...fastOptions,
        maxRetries: 3,
      })
    ).rejects.toThrow();

    expect(mockFetch).toHaveBeenCalledTimes(4); // 1 initial + 3 retries
  });

  it("should throw network error after max retries", async () => {
    mockFetch
      .mockRejectedValueOnce(new TypeError("Failed to fetch"))
      .mockRejectedValueOnce(new TypeError("Failed to fetch"));

    await expect(
      fetchWithRetry("https://api.example.com", {}, {
        ...fastOptions,
        maxRetries: 1,
      })
    ).rejects.toThrow("Failed to fetch");

    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it("should use exponential backoff timing", async () => {
    const delays: number[] = [];
    const originalSetTimeout = globalThis.setTimeout;
    vi.spyOn(globalThis, "setTimeout").mockImplementation(((fn: Function, delay: number) => {
      delays.push(delay);
      return originalSetTimeout(fn, 1); // execute immediately for test speed
    }) as typeof setTimeout);

    mockFetch
      .mockResolvedValueOnce({ ok: false, status: 500 })
      .mockResolvedValueOnce({ ok: false, status: 500 })
      .mockResolvedValueOnce({ ok: true, status: 200 });

    await fetchWithRetry("https://api.example.com", {}, {
      baseDelayMs: 100,
      maxDelayMs: 10000,
      maxRetries: 3,
    });

    // First retry delay should be around baseDelay (100ms + jitter)
    expect(delays[0]).toBeGreaterThanOrEqual(100);
    expect(delays[0]).toBeLessThan(300); // base + max jitter
    // Second retry should be larger (exponential)
    expect(delays[1]).toBeGreaterThan(delays[0]);

    vi.restoreAllMocks();
  });

  it("should respect maxDelayMs cap", async () => {
    const delays: number[] = [];
    const originalSetTimeout = globalThis.setTimeout;
    vi.spyOn(globalThis, "setTimeout").mockImplementation(((fn: Function, delay: number) => {
      delays.push(delay);
      return originalSetTimeout(fn, 1);
    }) as typeof setTimeout);

    mockFetch
      .mockResolvedValueOnce({ ok: false, status: 500 })
      .mockResolvedValueOnce({ ok: false, status: 500 })
      .mockResolvedValueOnce({ ok: false, status: 500 })
      .mockResolvedValueOnce({ ok: true, status: 200 });

    await fetchWithRetry("https://api.example.com", {}, {
      baseDelayMs: 1000,
      maxDelayMs: 2000,
      maxRetries: 3,
    });

    // All delays should be capped at maxDelayMs
    for (const delay of delays) {
      expect(delay).toBeLessThanOrEqual(2000);
    }

    vi.restoreAllMocks();
  });

  it("should pass through request options to fetch", async () => {
    mockFetch.mockResolvedValueOnce({ ok: true, status: 200 });

    await fetchWithRetry(
      "https://api.example.com",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: '{"key":"value"}',
      },
      fastOptions
    );

    const [url, options] = mockFetch.mock.calls[0];
    expect(url).toBe("https://api.example.com");
    expect(options.method).toBe("POST");
    expect(options.headers).toEqual({ "Content-Type": "application/json" });
  });
});
