"use client";

import { useState } from "react";
import { FileWithPath } from "@mantine/dropzone";
import { clientFetchWithRetry } from "@/lib/client-retry";
import { uploadChunksParallel } from "@/lib/upload-pool";
import { isSupportedExtension } from "@/lib/validation";

// 4MB chunk size to stay under Vercel's 4.5MB limit (free tier)
const CHUNK_SIZE = 4 * 1024 * 1024;
const FILE_CONCURRENCY = 2;

export interface FileWithProgress {
  file: FileWithPath;
  progress: number;
  status: "pending" | "uploading" | "completed" | "error";
  phase?: string;
  error?: string;
}

export function useFileUpload() {
  const [files, setFiles] = useState<FileWithProgress[]>([]);
  const [isUploading, setIsUploading] = useState(false);

  const cleanupUpload = async (uploadId: string) => {
    try {
      await clientFetchWithRetry("/api/upload/cleanup", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ uploadId }),
      });
    } catch (e) {
      console.error("Cleanup failed:", e);
    }
  };

  const uploadFileWithChunking = async (
    file: FileWithPath,
    fileIndex: number
  ) => {
    const totalChunks = Math.ceil(file.size / CHUNK_SIZE);
    const contentType = file.type || "application/octet-stream";
    let uploadId: string | null = null;

    const updateProgress = (progress: number, phase: string) => {
      setFiles((prev) =>
        prev.map((f, idx) =>
          idx === fileIndex ? { ...f, progress, phase } : f
        )
      );
    };

    try {
      // 1. Initialize upload
      updateProgress(0, "업로드 준비 중...");

      const initRes = await clientFetchWithRetry("/api/upload/init", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          filename: file.name,
          contentType,
          fileSize: file.size,
          totalChunks,
        }),
      });

      if (!initRes.ok) {
        const errorData = await initRes.json();
        throw new Error(errorData.error || "업로드 초기화 실패");
      }

      const initData = await initRes.json();
      uploadId = initData.uploadId;
      const useMultiPart = initData.useMultiPart;

      // 2. Upload chunks to Vercel Blob (parallel, 3 concurrent)
      const chunkItems = Array.from({ length: totalChunks }, (_, i) => ({
        blob: file.slice(i * CHUNK_SIZE, Math.min((i + 1) * CHUNK_SIZE, file.size)),
        partNumber: i + 1,
      }));

      await uploadChunksParallel(
        chunkItems,
        async (blob, partNumber) => {
          const formData = new FormData();
          formData.append("chunk", blob);
          formData.append("uploadId", uploadId!);
          formData.append("partNumber", String(partNumber));

          const chunkRes = await clientFetchWithRetry("/api/upload/chunk", {
            method: "POST",
            body: formData,
          }, { maxRetries: 5 });

          if (!chunkRes.ok) {
            const errorData = await chunkRes.json();
            throw new Error(errorData.error || `청크 ${partNumber} 업로드 실패`);
          }
        },
        {
          concurrency: 3,
          onProgress: (completed, total) => {
            const chunkPhase =
              total > 1 ? `업로드 중 (${completed}/${total})` : "업로드 중...";
            const chunkProgress = 5 + (completed / total) * 85;
            updateProgress(chunkProgress, chunkPhase);
          },
        }
      );

      // 3. Complete upload via SSE (streams progress from server)
      updateProgress(92, "Notion에 전송 준비 중...");

      const completeFormData = new FormData();
      completeFormData.append("uploadId", uploadId!);
      completeFormData.append("filename", file.name);
      completeFormData.append("contentType", contentType);
      completeFormData.append("totalChunks", String(totalChunks));
      completeFormData.append("useMultiPart", String(useMultiPart));
      completeFormData.append("fileSize", String(file.size));

      // SSE: no retry on this call (streaming response)
      const completeRes = await fetch("/api/upload/complete", {
        method: "POST",
        body: completeFormData,
      });

      if (!completeRes.ok) {
        const errorData = await completeRes.json();
        throw new Error(errorData.error || "업로드 완료 처리 실패");
      }

      // Consume SSE stream for real-time progress
      const reader = completeRes.body!.getReader();
      const decoder = new TextDecoder();
      let sseError: string | null = null;

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        const text = decoder.decode(value, { stream: true });
        for (const line of text.split("\n")) {
          if (!line.startsWith("data: ")) continue;
          try {
            const event = JSON.parse(line.slice(6));

            if (event.phase === "reading") {
              updateProgress(92, "Blob 청크 읽는 중...");
            } else if (event.phase === "sending") {
              const progress = 92 + (event.partNumber / event.totalParts) * 5;
              updateProgress(progress, event.message);
            } else if (event.phase === "attaching") {
              updateProgress(98, "페이지에 첨부 중...");
            } else if (event.phase === "cleanup") {
              updateProgress(99, "정리 중...");
            } else if (event.phase === "error") {
              sseError = event.error;
            }
          } catch {
            // skip malformed SSE lines
          }
        }
      }

      if (sseError) {
        throw new Error(sseError);
      }

      // Success
      setFiles((prev) =>
        prev.map((f, idx) =>
          idx === fileIndex
            ? { ...f, status: "completed", progress: 100, phase: "완료!" }
            : f
        )
      );
    } catch (error) {
      // Cleanup Vercel Blob chunks on error
      if (uploadId) {
        await cleanupUpload(uploadId);
      }

      setFiles((prev) =>
        prev.map((f, idx) =>
          idx === fileIndex
            ? {
                ...f,
                status: "error",
                error: error instanceof Error ? error.message : "업로드 실패",
              }
            : f
        )
      );
    }
  };

  const handleDrop = async (acceptedFiles: FileWithPath[]) => {
    const newFiles: FileWithProgress[] = acceptedFiles.map((file) => {
      if (!isSupportedExtension(file.name)) {
        const ext = file.name.slice(file.name.lastIndexOf(".")).toLowerCase();
        return {
          file,
          progress: 0,
          status: "error" as const,
          error: `지원되지 않는 파일 형식입니다 (${ext}). 이미지, 문서, 오디오, 비디오 파일만 업로드할 수 있습니다.`,
        };
      }
      return {
        file,
        progress: 0,
        status: "pending" as const,
      };
    });

    const startIndex = files.length;
    setFiles((prev) => [...prev, ...newFiles]);

    const uploadableFiles = newFiles.filter((f) => f.status === "pending");
    if (uploadableFiles.length === 0) return;

    setIsUploading(true);

    // Upload up to 2 files in parallel using sliding window
    const uploadableIndices = newFiles
      .map((f, i) => ({ file: f, index: startIndex + i }))
      .filter(({ file }) => file.status !== "error");

    await new Promise<void>((resolve) => {
      let nextIdx = 0;
      let activeCount = 0;

      function startNext() {
        while (activeCount < FILE_CONCURRENCY && nextIdx < uploadableIndices.length) {
          const { file, index } = uploadableIndices[nextIdx++];
          activeCount++;
          setFiles((prev) =>
            prev.map((f, idx) =>
              idx === index ? { ...f, status: "uploading" } : f
            )
          );
          uploadFileWithChunking(file.file, index).finally(() => {
            activeCount--;
            if (nextIdx < uploadableIndices.length) {
              startNext();
            } else if (activeCount === 0) {
              resolve();
            }
          });
        }
      }

      if (uploadableIndices.length === 0) resolve();
      else startNext();
    });

    setIsUploading(false);
  };

  const clearCompleted = () => {
    setFiles((prev) =>
      prev.filter((f) => f.status !== "completed" && f.status !== "error")
    );
  };

  return { files, isUploading, handleDrop, clearCompleted };
}
