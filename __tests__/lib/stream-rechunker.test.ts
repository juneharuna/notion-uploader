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
    // Part 1: 10MB, Part 2: 10MB, Part 3: 10MB, Part 4: 2MB
    expect(sendFileData).toHaveBeenCalledTimes(4);

    // Verify part numbers
    const calls = (sendFileData as ReturnType<typeof vi.fn>).mock.calls;
    expect(calls[0][3]).toBe(1);
    expect(calls[1][3]).toBe(2);
    expect(calls[2][3]).toBe(3);
    expect(calls[3][3]).toBe(4);

    // Verify sizes
    expect(calls[0][1].length).toBe(NOTION_CHUNK_SIZE); // 10MB
    expect(calls[1][1].length).toBe(NOTION_CHUNK_SIZE); // 10MB
    expect(calls[2][1].length).toBe(NOTION_CHUNK_SIZE); // 10MB
    expect(calls[3][1].length).toBe(2 * 1024 * 1024); // 2MB remainder

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
    expect(calls[0][1].length).toBe(NOTION_CHUNK_SIZE); // 10MB
    expect(calls[1][1].length).toBe(NOTION_CHUNK_SIZE); // 10MB
  });

  it("should call onPartSent callback for multi-part", async () => {
    const blobChunkSize = 4 * 1024 * 1024;
    const blobs = createMockBlobs(8, blobChunkSize); // 32MB

    mockFetch.mockImplementation(() => {
      return Promise.resolve(createMockBlobResponse(blobChunkSize));
    });

    const onPartSent = vi.fn();
    await streamToNotion(
      "upload-123",
      blobs,
      "application/zip",
      true,
      onPartSent
    );

    // 4 parts sent
    expect(onPartSent).toHaveBeenCalledTimes(4);
    expect(onPartSent).toHaveBeenNthCalledWith(1, 1, 4);
    expect(onPartSent).toHaveBeenNthCalledWith(2, 2, 4);
    expect(onPartSent).toHaveBeenNthCalledWith(3, 3, 4);
    expect(onPartSent).toHaveBeenNthCalledWith(4, 4, 4);
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
});
