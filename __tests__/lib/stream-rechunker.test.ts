import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock notion.ts functions
vi.mock("@/lib/notion", () => ({
  sendFileData: vi.fn().mockResolvedValue({ id: "test", status: "uploaded" }),
  completeMultiPartUpload: vi
    .fn()
    .mockResolvedValue({ id: "test", status: "uploaded" }),
}));

// Mock fetch for Blob URL fetching
const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

import { streamToNotion } from "@/lib/stream-rechunker";
import { sendFileData, completeMultiPartUpload } from "@/lib/notion";

const NOTION_CHUNK_SIZE = 10 * 1024 * 1024; // 10MB

function createMockBlobs(
  count: number,
  chunkSize: number
): { url: string; pathname: string }[] {
  return Array.from({ length: count }, (_, i) => ({
    url: `https://blob.vercel-storage.com/chunks/upload-123/${i + 1}`,
    pathname: `chunks/upload-123/${i + 1}`,
  }));
}

function createMockBlobResponse(size: number): {
  arrayBuffer: () => Promise<ArrayBuffer>;
} {
  const buffer = new ArrayBuffer(size);
  return { arrayBuffer: () => Promise.resolve(buffer) };
}

/**
 * Helper: build a map from part_number to [uploadId, buffer, contentType, partNumber]
 */
function getCallsByPartNumber(calls: unknown[][]) {
  const map = new Map<number, unknown[]>();
  for (const call of calls) {
    map.set(call[3] as number, call);
  }
  return map;
}

describe("streamToNotion", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("should handle single-part upload (file <= 20MB)", async () => {
    const blobChunkSize = 4 * 1024 * 1024; // 4MB
    const blobs = createMockBlobs(3, blobChunkSize); // 12MB total

    mockFetch.mockImplementation((url: string) => {
      return Promise.resolve(createMockBlobResponse(blobChunkSize));
    });

    await streamToNotion("upload-123", blobs, "application/pdf", false);

    // Single-part: one sendFileData call without part number
    expect(sendFileData).toHaveBeenCalledOnce();
    const [uploadId, buffer, contentType, partNumber] = (
      sendFileData as ReturnType<typeof vi.fn>
    ).mock.calls[0];
    expect(uploadId).toBe("upload-123");
    expect(buffer.length).toBe(3 * blobChunkSize); // 12MB
    expect(contentType).toBe("application/pdf");
    expect(partNumber).toBeUndefined();

    // Single-part: no completeMultiPartUpload
    expect(completeMultiPartUpload).not.toHaveBeenCalled();
  });

  it("should handle multi-part upload (file > 20MB)", async () => {
    const blobChunkSize = 4 * 1024 * 1024; // 4MB
    const blobCount = 8; // 32MB total
    const blobs = createMockBlobs(blobCount, blobChunkSize);

    mockFetch.mockImplementation(() => {
      return Promise.resolve(createMockBlobResponse(blobChunkSize));
    });

    await streamToNotion(
      "upload-123",
      blobs,
      "application/zip",
      true
    );

    // 32MB / 10MB = 3 full parts + 1 partial (2MB)
    expect(sendFileData).toHaveBeenCalledTimes(4);

    // Verify all part numbers are present (order may vary due to parallel sends)
    const calls = (sendFileData as ReturnType<typeof vi.fn>).mock.calls;
    const partNumbers = calls.map((c: unknown[]) => c[3] as number).sort();
    expect(partNumbers).toEqual([1, 2, 3, 4]);

    // Verify sizes by part number
    const byPart = getCallsByPartNumber(calls);
    expect((byPart.get(1)![1] as Buffer).length).toBe(NOTION_CHUNK_SIZE); // 10MB
    expect((byPart.get(2)![1] as Buffer).length).toBe(NOTION_CHUNK_SIZE); // 10MB
    expect((byPart.get(3)![1] as Buffer).length).toBe(NOTION_CHUNK_SIZE); // 10MB
    expect((byPart.get(4)![1] as Buffer).length).toBe(2 * 1024 * 1024); // 2MB remainder

    // Multi-part: completeMultiPartUpload should be called
    expect(completeMultiPartUpload).toHaveBeenCalledWith("upload-123");
  });

  it("should handle exact 10MB chunk boundary", async () => {
    const blobChunkSize = 5 * 1024 * 1024; // 5MB
    const blobs = createMockBlobs(4, blobChunkSize); // 20MB total

    mockFetch.mockImplementation(() => {
      return Promise.resolve(createMockBlobResponse(blobChunkSize));
    });

    await streamToNotion("upload-123", blobs, "application/zip", true);

    // 20MB / 10MB = exactly 2 parts
    expect(sendFileData).toHaveBeenCalledTimes(2);
    const calls = (sendFileData as ReturnType<typeof vi.fn>).mock.calls;
    const byPart = getCallsByPartNumber(calls);
    expect((byPart.get(1)![1] as Buffer).length).toBe(NOTION_CHUNK_SIZE); // 10MB
    expect((byPart.get(2)![1] as Buffer).length).toBe(NOTION_CHUNK_SIZE); // 10MB
  });

  it("should call onPartSent callback for multi-part with totalFileSize", async () => {
    const blobChunkSize = 4 * 1024 * 1024;
    const blobs = createMockBlobs(8, blobChunkSize); // 32MB
    const totalFileSize = 8 * blobChunkSize; // 32MB

    mockFetch.mockImplementation(() => {
      return Promise.resolve(createMockBlobResponse(blobChunkSize));
    });

    const onPartSent = vi.fn();
    await streamToNotion(
      "upload-123",
      blobs,
      "application/zip",
      true,
      onPartSent,
      totalFileSize
    );

    // 4 parts sent
    expect(onPartSent).toHaveBeenCalledTimes(4);

    // Verify all part numbers were reported (order may vary due to parallel sends)
    const sentParts = onPartSent.mock.calls.map((c: unknown[]) => c[0] as number).sort();
    expect(sentParts).toEqual([1, 2, 3, 4]);

    // Each callback should report totalParts = 4 (calculated from totalFileSize)
    for (const call of onPartSent.mock.calls) {
      expect(call[1]).toBe(4); // Math.ceil(32MB / 10MB) = 4
    }
  });

  it("should throw on Blob fetch error", async () => {
    const blobs = createMockBlobs(3, 4 * 1024 * 1024);

    mockFetch
      .mockResolvedValueOnce(createMockBlobResponse(4 * 1024 * 1024))
      .mockRejectedValueOnce(new Error("Blob fetch failed"));

    await expect(
      streamToNotion("upload-123", blobs, "application/pdf", false)
    ).rejects.toThrow("Blob fetch failed");
  });

  it("should propagate sendFileData errors", async () => {
    const blobChunkSize = 4 * 1024 * 1024;
    const blobs = createMockBlobs(8, blobChunkSize); // 32MB

    mockFetch.mockImplementation(() => {
      return Promise.resolve(createMockBlobResponse(blobChunkSize));
    });

    (sendFileData as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce({ id: "test", status: "uploaded" })
      .mockRejectedValueOnce(new Error("Notion API error"));

    await expect(
      streamToNotion("upload-123", blobs, "application/zip", true)
    ).rejects.toThrow("Notion API error");
  });

  it("should use prefetch for single-part (verifies all blobs are fetched)", async () => {
    const blobChunkSize = 4 * 1024 * 1024;
    const blobs = createMockBlobs(5, blobChunkSize); // 20MB

    mockFetch.mockImplementation(() => {
      return Promise.resolve(createMockBlobResponse(blobChunkSize));
    });

    await streamToNotion("upload-123", blobs, "application/pdf", false);

    // All 5 blobs should be fetched
    expect(mockFetch).toHaveBeenCalledTimes(5);

    // Combined buffer should be 20MB
    const [, buffer] = (sendFileData as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(buffer.length).toBe(5 * blobChunkSize);
  });
});
