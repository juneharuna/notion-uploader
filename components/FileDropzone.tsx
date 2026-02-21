"use client";

import { useRef, useState } from "react";
import { Dropzone, FileWithPath } from "@mantine/dropzone";
import {
  Group,
  Text,
  rem,
  Stack,
  Paper,
  Progress,
  Badge,
  ThemeIcon,
} from "@mantine/core";
import { formatFileSize } from "@/lib/notion";
import { clientFetchWithRetry } from "@/lib/client-retry";
import { uploadChunksParallel } from "@/lib/upload-pool";

// 4MB chunk size to stay under Vercel's 4.5MB limit (free tier)
const CHUNK_SIZE = 4 * 1024 * 1024;

// Notion File Upload API supported extensions
const SUPPORTED_EXTENSIONS = new Set([
  // Image
  ".gif", ".heic", ".jpeg", ".jpg", ".png", ".svg", ".tif", ".tiff", ".webp", ".ico",
  // Document
  ".pdf", ".txt", ".json", ".doc", ".dot", ".docx", ".dotx",
  ".xls", ".xlt", ".xla", ".xlsx", ".xltx",
  ".ppt", ".pot", ".pps", ".ppa", ".pptx", ".potx",
  // Audio
  ".aac", ".adts", ".mid", ".midi", ".mp3", ".mpga", ".m4a", ".m4b", ".oga", ".ogg", ".wav", ".wma",
  // Video
  ".amv", ".asf", ".wmv", ".avi", ".f4v", ".flv", ".gifv", ".m4v", ".mp4", ".mkv", ".webm", ".mov", ".qt", ".mpeg",
]);

function isSupportedExtension(filename: string): boolean {
  const ext = filename.slice(filename.lastIndexOf(".")).toLowerCase();
  return SUPPORTED_EXTENSIONS.has(ext);
}

interface FileWithProgress {
  file: FileWithPath;
  progress: number;
  status: "pending" | "uploading" | "completed" | "error";
  phase?: string;
  error?: string;
}

export default function FileDropzone() {
  const [files, setFiles] = useState<FileWithProgress[]>([]);
  const [isUploading, setIsUploading] = useState(false);
  const openRef = useRef<() => void>(null);

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

    // Update phase
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
            } else if (event.phase === "done") {
              // handled below
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
    // Validate file extensions before starting upload
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

    setFiles((prev) => [...prev, ...newFiles]);

    const uploadableFiles = newFiles.filter((f) => f.status === "pending");
    if (uploadableFiles.length === 0) return;

    setIsUploading(true);

    const startIndex = files.length;

    // Upload up to 2 files in parallel using sliding window
    const FILE_CONCURRENCY = 2;
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

  const getStatusColor = (status: string) => {
    switch (status) {
      case "completed":
        return "green";
      case "error":
        return "red";
      case "uploading":
        return "blue";
      default:
        return "gray";
    }
  };

  const clearCompleted = () => {
    setFiles((prev) =>
      prev.filter((f) => f.status !== "completed" && f.status !== "error")
    );
  };

  return (
    <Stack gap="md">
      <Dropzone
        onDrop={handleDrop}
        loading={isUploading}
        openRef={openRef}
        maxSize={5 * 1024 * 1024 * 1024} // 5GB
        styles={{
          root: {
            minHeight: rem(200),
            display: "flex",
            justifyContent: "center",
            alignItems: "center",
            border: "2px dashed var(--mantine-color-dimmed)",
            borderRadius: "var(--mantine-radius-md)",
            cursor: "pointer",
            "&:hover": {
              backgroundColor: "var(--mantine-color-gray-0)",
            },
          },
        }}
      >
        <Group
          justify="center"
          gap="xl"
          style={{ minHeight: rem(150), pointerEvents: "none" }}
        >
          <Dropzone.Accept>
            <ThemeIcon size={52} radius="xl" color="blue">
              <UploadIcon style={{ width: rem(28), height: rem(28) }} />
            </ThemeIcon>
          </Dropzone.Accept>
          <Dropzone.Reject>
            <ThemeIcon size={52} radius="xl" color="red">
              <XIcon style={{ width: rem(28), height: rem(28) }} />
            </ThemeIcon>
          </Dropzone.Reject>
          <Dropzone.Idle>
            <ThemeIcon size={52} radius="xl" color="gray" variant="light">
              <FileIcon style={{ width: rem(28), height: rem(28) }} />
            </ThemeIcon>
          </Dropzone.Idle>

          <div>
            <Text size="xl" inline>
              파일을 드래그하거나 클릭하여 선택
            </Text>
            <Text size="sm" c="dimmed" inline mt={7}>
              파일 크기 제한: 5GB (Notion 유료 플랜)
            </Text>
          </div>
        </Group>
      </Dropzone>

      {files.length > 0 && (
        <Stack gap="sm">
          <Group justify="space-between">
            <Text size="sm" fw={500}>
              업로드 파일 ({files.length})
            </Text>
            <Text
              size="sm"
              c="dimmed"
              style={{ cursor: "pointer" }}
              onClick={clearCompleted}
            >
              완료된 항목 지우기
            </Text>
          </Group>

          {files.map((fileWithProgress, index) => (
            <Paper key={index} p="sm" withBorder>
              <Group justify="space-between" mb={5}>
                <Group gap="xs">
                  <Text size="sm" fw={500} lineClamp={1} style={{ maxWidth: 200 }}>
                    {fileWithProgress.file.name}
                  </Text>
                  <Badge size="xs" variant="light">
                    {formatFileSize(fileWithProgress.file.size)}
                  </Badge>
                </Group>
                <Badge color={getStatusColor(fileWithProgress.status)} size="sm">
                  {fileWithProgress.status === "completed" && "완료"}
                  {fileWithProgress.status === "error" && "오류"}
                  {fileWithProgress.status === "uploading" && "업로드 중"}
                  {fileWithProgress.status === "pending" && "대기 중"}
                </Badge>
              </Group>

              {fileWithProgress.status === "uploading" && (
                <>
                  <Progress
                    value={fileWithProgress.progress}
                    size="sm"
                    animated
                    mb={5}
                  />
                  <Text size="xs" c="dimmed">
                    {fileWithProgress.phase}
                  </Text>
                </>
              )}

              {fileWithProgress.status === "error" && (
                <Text size="xs" c="red">
                  {fileWithProgress.error}
                </Text>
              )}
            </Paper>
          ))}
        </Stack>
      )}
    </Stack>
  );
}

// Simple SVG icons
function UploadIcon({ style }: { style?: React.CSSProperties }) {
  return (
    <svg
      style={style}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
      <polyline points="17 8 12 3 7 8" />
      <line x1="12" y1="3" x2="12" y2="15" />
    </svg>
  );
}

function XIcon({ style }: { style?: React.CSSProperties }) {
  return (
    <svg
      style={style}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <line x1="18" y1="6" x2="6" y2="18" />
      <line x1="6" y1="6" x2="18" y2="18" />
    </svg>
  );
}

function FileIcon({ style }: { style?: React.CSSProperties }) {
  return (
    <svg
      style={style}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
      <polyline points="14 2 14 8 20 8" />
    </svg>
  );
}
