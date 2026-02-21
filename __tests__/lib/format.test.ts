import { describe, it, expect } from "vitest";
import { formatFileSize } from "@/lib/format";

describe("lib/format", () => {
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
