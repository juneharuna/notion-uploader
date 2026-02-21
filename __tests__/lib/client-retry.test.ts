import { describe, it, expect, vi, beforeEach } from "vitest";
import { clientFetchWithRetry, type ClientRetryOptions } from "@/lib/client-retry";

const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

const fastOptions: Partial<ClientRetryOptions> = {
  baseDelayMs: 1,
  maxDelayMs: 10,
};

describe("clientFetchWithRetry", () => {
  beforeEach(() => {
    mockFetch.mockReset();
  });

  it("should return response on first success", async () => {
    mockFetch.mockResolvedValueOnce({ ok: true, status: 200 });

    const res = await clientFetchWithRetry("https://example.com/api", {}, fastOptions);

    expect(res.ok).toBe(true);
    expect(mockFetch).toHaveBeenCalledOnce();
  });

  it("should retry on 500 and succeed on second attempt", async () => {
    mockFetch
      .mockResolvedValueOnce({ ok: false, status: 500 })
      .mockResolvedValueOnce({ ok: true, status: 200 });

    const res = await clientFetchWithRetry(
      "https://example.com/api",
      {},
      { ...fastOptions, maxRetries: 3 }
    );

    expect(res.ok).toBe(true);
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it("should NOT retry on 422 (non-retryable)", async () => {
    mockFetch.mockResolvedValueOnce({ ok: false, status: 422 });

    const res = await clientFetchWithRetry(
      "https://example.com/api",
      {},
      { ...fastOptions, maxRetries: 3 }
    );

    expect(res.ok).toBe(false);
    expect(res.status).toBe(422);
    expect(mockFetch).toHaveBeenCalledOnce();
  });

  it("should NOT retry on 400, 401, 403, 404", async () => {
    for (const status of [400, 401, 403, 404]) {
      mockFetch.mockReset();
      mockFetch.mockResolvedValueOnce({ ok: false, status });

      const res = await clientFetchWithRetry(
        "https://example.com/api",
        {},
        { ...fastOptions, maxRetries: 3 }
      );

      expect(res.status).toBe(status);
      expect(mockFetch).toHaveBeenCalledOnce();
    }
  });

  it("should include response body in error after max retries", async () => {
    mockFetch.mockResolvedValue({
      ok: false,
      status: 500,
      text: () => Promise.resolve('{"error":"Notion rate limit"}'),
    });

    await expect(
      clientFetchWithRetry("https://example.com/api", {}, {
        ...fastOptions,
        maxRetries: 2,
      })
    ).rejects.toThrow('Request failed after 2 retries (500): {"error":"Notion rate limit"}');

    expect(mockFetch).toHaveBeenCalledTimes(3); // 1 initial + 2 retries
  });

  it("should handle body read failure gracefully", async () => {
    mockFetch.mockResolvedValue({
      ok: false,
      status: 500,
      text: () => Promise.reject(new Error("body read error")),
    });

    await expect(
      clientFetchWithRetry("https://example.com/api", {}, {
        ...fastOptions,
        maxRetries: 1,
      })
    ).rejects.toThrow("Request failed after 1 retries (500): no response body");
  });

  it("should retry on network error (TypeError)", async () => {
    mockFetch
      .mockRejectedValueOnce(new TypeError("Failed to fetch"))
      .mockResolvedValueOnce({ ok: true, status: 200 });

    const res = await clientFetchWithRetry(
      "https://example.com/api",
      {},
      { ...fastOptions, maxRetries: 3 }
    );

    expect(res.ok).toBe(true);
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it("should throw network error after max retries", async () => {
    mockFetch
      .mockRejectedValueOnce(new TypeError("Failed to fetch"))
      .mockRejectedValueOnce(new TypeError("Failed to fetch"));

    await expect(
      clientFetchWithRetry("https://example.com/api", {}, {
        ...fastOptions,
        maxRetries: 1,
      })
    ).rejects.toThrow("Failed to fetch");

    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it("should handle 429 with Retry-After header", async () => {
    const retryAfterResponse = {
      ok: false,
      status: 429,
      headers: { get: (name: string) => name === "Retry-After" ? "1" : null },
    };
    mockFetch
      .mockResolvedValueOnce(retryAfterResponse)
      .mockResolvedValueOnce({ ok: true, status: 200 });

    const res = await clientFetchWithRetry(
      "https://example.com/api",
      {},
      { ...fastOptions, maxRetries: 3 }
    );

    expect(res.ok).toBe(true);
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it("should pass through request options to fetch", async () => {
    mockFetch.mockResolvedValueOnce({ ok: true, status: 200 });

    await clientFetchWithRetry(
      "https://example.com/api",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: '{"key":"value"}',
      },
      fastOptions
    );

    const [url, options] = mockFetch.mock.calls[0];
    expect(url).toBe("https://example.com/api");
    expect(options.method).toBe("POST");
    expect(options.headers).toEqual({ "Content-Type": "application/json" });
  });
});
