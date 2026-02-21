import { describe, it, expect, vi } from "vitest";
import { uploadChunksParallel } from "@/lib/upload-pool";

function createMockChunks(count: number): { blob: Blob; partNumber: number }[] {
  return Array.from({ length: count }, (_, i) => ({
    blob: new Blob(["x".repeat(100)]),
    partNumber: i + 1,
  }));
}

describe("uploadChunksParallel", () => {
  it("should upload all chunks", async () => {
    const chunks = createMockChunks(5);
    const uploaded: number[] = [];
    const uploadFn = vi.fn(async (_blob: Blob, partNumber: number) => {
      uploaded.push(partNumber);
    });

    await uploadChunksParallel(chunks, uploadFn, { concurrency: 3 });

    expect(uploadFn).toHaveBeenCalledTimes(5);
    expect(uploaded.sort()).toEqual([1, 2, 3, 4, 5]);
  });

  it("should respect concurrency limit", async () => {
    const chunks = createMockChunks(10);
    let concurrent = 0;
    let maxConcurrent = 0;

    const uploadFn = vi.fn(async () => {
      concurrent++;
      maxConcurrent = Math.max(maxConcurrent, concurrent);
      // Simulate async work
      await new Promise((resolve) => setTimeout(resolve, 10));
      concurrent--;
    });

    await uploadChunksParallel(chunks, uploadFn, { concurrency: 3 });

    expect(maxConcurrent).toBeLessThanOrEqual(3);
    expect(uploadFn).toHaveBeenCalledTimes(10);
  });

  it("should abort remaining on error", async () => {
    const chunks = createMockChunks(10);
    let callCount = 0;

    const uploadFn = vi.fn(async (_blob: Blob, partNumber: number) => {
      callCount++;
      if (partNumber === 3) {
        throw new Error("Upload failed on chunk 3");
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    });

    await expect(
      uploadChunksParallel(chunks, uploadFn, { concurrency: 2 })
    ).rejects.toThrow("Upload failed on chunk 3");

    // Should not have uploaded all 10 (aborted early)
    expect(callCount).toBeLessThan(10);
  });

  it("should call onProgress callback correctly", async () => {
    const chunks = createMockChunks(5);
    const progressCalls: [number, number][] = [];

    const uploadFn = vi.fn(async () => {
      await new Promise((resolve) => setTimeout(resolve, 5));
    });

    await uploadChunksParallel(chunks, uploadFn, {
      concurrency: 2,
      onProgress: (completed, total) => {
        progressCalls.push([completed, total]);
      },
    });

    // Should have 5 progress calls (one per completion)
    expect(progressCalls.length).toBe(5);
    // Total should always be 5
    expect(progressCalls.every(([, total]) => total === 5)).toBe(true);
    // Last call should show all completed
    expect(progressCalls[progressCalls.length - 1][0]).toBe(5);
  });

  it("should handle single chunk", async () => {
    const chunks = createMockChunks(1);
    const uploadFn = vi.fn(async () => {});

    await uploadChunksParallel(chunks, uploadFn, { concurrency: 3 });

    expect(uploadFn).toHaveBeenCalledOnce();
  });

  it("should handle empty chunks array", async () => {
    const uploadFn = vi.fn(async () => {});

    await uploadChunksParallel([], uploadFn, { concurrency: 3 });

    expect(uploadFn).not.toHaveBeenCalled();
  });
});
