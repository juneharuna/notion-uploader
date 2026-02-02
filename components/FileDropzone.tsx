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

// 4MB chunk size to stay under Vercel's 4.5MB limit (free tier)
const CHUNK_SIZE = 4 * 1024 * 1024;

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

  const uploadFileWithChunking = async (
    file: FileWithPath,
    fileIndex: number
  ) => {
    const totalChunks = Math.ceil(file.size / CHUNK_SIZE);
    const contentType = file.type || "application/octet-stream";

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

      const initRes = await fetch("/api/upload/init", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          filename: file.name,
          contentType,
          totalChunks,
        }),
      });

      if (!initRes.ok) {
        const errorData = await initRes.json();
        throw new Error(errorData.error || "업로드 초기화 실패");
      }

      const { uploadId } = await initRes.json();

      // 2. Upload chunks
      for (let i = 0; i < totalChunks; i++) {
        const start = i * CHUNK_SIZE;
        const end = Math.min(start + CHUNK_SIZE, file.size);
        const chunk = file.slice(start, end);

        const formData = new FormData();
        formData.append("chunk", chunk);
        formData.append("uploadId", uploadId);
        formData.append("partNumber", String(i + 1));
        formData.append("contentType", contentType);

        const chunkPhase =
          totalChunks > 1
            ? `업로드 중 (${i + 1}/${totalChunks})`
            : "업로드 중...";

        // Progress: 5% for init, 85% for chunks, 10% for completion
        const chunkProgress = 5 + ((i + 1) / totalChunks) * 85;
        updateProgress(chunkProgress, chunkPhase);

        const chunkRes = await fetch("/api/upload/chunk", {
          method: "POST",
          body: formData,
        });

        if (!chunkRes.ok) {
          const errorData = await chunkRes.json();
          throw new Error(errorData.error || `청크 ${i + 1} 업로드 실패`);
        }
      }

      // 3. Complete upload
      updateProgress(92, "Notion에 첨부 중...");

      const completeRes = await fetch("/api/upload/complete", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          uploadId,
          filename: file.name,
          totalChunks,
        }),
      });

      if (!completeRes.ok) {
        const errorData = await completeRes.json();
        throw new Error(errorData.error || "업로드 완료 처리 실패");
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
    const newFiles: FileWithProgress[] = acceptedFiles.map((file) => ({
      file,
      progress: 0,
      status: "pending" as const,
    }));

    setFiles((prev) => [...prev, ...newFiles]);
    setIsUploading(true);

    const startIndex = files.length;

    for (let i = 0; i < newFiles.length; i++) {
      const fileIndex = startIndex + i;

      setFiles((prev) =>
        prev.map((f, idx) =>
          idx === fileIndex ? { ...f, status: "uploading" } : f
        )
      );

      await uploadFileWithChunking(newFiles[i].file, fileIndex);
    }

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
