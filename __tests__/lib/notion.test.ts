import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Mock environment variables before importing
vi.stubEnv("NOTION_API_KEY", "ntn_test_key");
vi.stubEnv("NOTION_PAGE_ID", "test-page-id");

const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

import {
  createFileUpload,
  sendFileData,
  completeMultiPartUpload,
  attachFileToPage,
  formatFileSize,
} from "@/lib/notion";

describe("lib/notion", () => {
  beforeEach(() => {
    mockFetch.mockReset();
  });

  describe("createFileUpload", () => {
    it("should create a single-part file upload", async () => {
      const mockResponse = { id: "upload-123", status: "uploaded" };
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve(mockResponse),
      });

      const result = await createFileUpload("test.pdf", "application/pdf");

      expect(mockFetch).toHaveBeenCalledOnce();
      const [url, options] = mockFetch.mock.calls[0];
      expect(url).toBe("https://api.notion.com/v1/file_uploads");
      expect(options.method).toBe("POST");
      expect(JSON.parse(options.body)).toEqual({
        filename: "test.pdf",
        content_type: "application/pdf",
      });
      expect(result).toEqual(mockResponse);
    });

    it("should create a multi-part file upload", async () => {
      const mockResponse = { id: "upload-456", status: "uploaded" };
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve(mockResponse),
      });

      const result = await createFileUpload(
        "large.zip",
        "application/zip",
        true,
        5
      );

      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(body.mode).toBe("multi_part");
      expect(body.number_of_parts).toBe(5);
      expect(result).toEqual(mockResponse);
    });

    it("should throw on API error", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        text: () => Promise.resolve("Unauthorized"),
      });

      await expect(
        createFileUpload("test.pdf", "application/pdf")
      ).rejects.toThrow("Failed to create file upload: Unauthorized");
    });
  });

  describe("sendFileData", () => {
    it("should send file data without part number for single-part", async () => {
      const mockResponse = { id: "upload-123", status: "uploaded" };
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve(mockResponse),
      });

      const buffer = Buffer.from("test data");
      const result = await sendFileData(
        "upload-123",
        buffer,
        "application/octet-stream"
      );

      const [url, options] = mockFetch.mock.calls[0];
      expect(url).toBe(
        "https://api.notion.com/v1/file_uploads/upload-123/send"
      );
      expect(options.method).toBe("POST");
      expect(options.body).toBeInstanceOf(FormData);
      expect(result).toEqual(mockResponse);
    });

    it("should send file data with part number for multi-part", async () => {
      const mockResponse = { id: "upload-123", status: "uploaded" };
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve(mockResponse),
      });

      const buffer = Buffer.from("test data");
      await sendFileData("upload-123", buffer, "application/octet-stream", 3);

      const formData = mockFetch.mock.calls[0][1].body as FormData;
      expect(formData.get("part_number")).toBe("3");
    });

    it("should throw on API error", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        text: () => Promise.resolve("Upload failed"),
      });

      const buffer = Buffer.from("test data");
      await expect(
        sendFileData("upload-123", buffer, "application/octet-stream")
      ).rejects.toThrow("Failed to send file data: Upload failed");
    });
  });

  describe("completeMultiPartUpload", () => {
    it("should complete multi-part upload", async () => {
      const mockResponse = {
        id: "upload-123",
        status: "uploaded",
        file_url: { url: "https://example.com/file", expiry_time: "2026-01-01" },
      };
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve(mockResponse),
      });

      const result = await completeMultiPartUpload("upload-123");

      const [url, options] = mockFetch.mock.calls[0];
      expect(url).toBe(
        "https://api.notion.com/v1/file_uploads/upload-123/complete"
      );
      expect(options.method).toBe("POST");
      expect(result).toEqual(mockResponse);
    });

    it("should throw on API error", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        text: () => Promise.resolve("Not found"),
      });

      await expect(completeMultiPartUpload("upload-123")).rejects.toThrow(
        "Failed to complete upload: Not found"
      );
    });
  });

  describe("attachFileToPage", () => {
    it("should attach file to default page", async () => {
      mockFetch.mockResolvedValueOnce({ ok: true });

      await attachFileToPage("upload-123", "test.pdf");

      const [url, options] = mockFetch.mock.calls[0];
      expect(url).toBe(
        "https://api.notion.com/v1/blocks/test-page-id/children"
      );
      expect(options.method).toBe("PATCH");

      const body = JSON.parse(options.body);
      expect(body.children[0].type).toBe("file");
      expect(body.children[0].file.file_upload.id).toBe("upload-123");
    });

    it("should attach file to specified page", async () => {
      mockFetch.mockResolvedValueOnce({ ok: true });

      await attachFileToPage("upload-123", "test.pdf", "custom-page-id");

      const [url] = mockFetch.mock.calls[0];
      expect(url).toBe(
        "https://api.notion.com/v1/blocks/custom-page-id/children"
      );
    });

    it("should throw on API error", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        text: () => Promise.resolve("Permission denied"),
      });

      await expect(
        attachFileToPage("upload-123", "test.pdf")
      ).rejects.toThrow("Failed to attach file to page: Permission denied");
    });
  });

  describe("formatFileSize", () => {
    it("should format 0 bytes", () => {
      expect(formatFileSize(0)).toBe("0 Bytes");
    });

    it("should format bytes", () => {
      expect(formatFileSize(500)).toBe("500 Bytes");
    });

    it("should format KB", () => {
      expect(formatFileSize(1024)).toBe("1 KB");
    });

    it("should format MB", () => {
      expect(formatFileSize(1024 * 1024)).toBe("1 MB");
    });

    it("should format GB", () => {
      expect(formatFileSize(1024 * 1024 * 1024)).toBe("1 GB");
    });

    it("should format with decimals", () => {
      expect(formatFileSize(1536)).toBe("1.5 KB");
    });
  });
});
