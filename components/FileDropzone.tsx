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
  ActionIcon,
  ThemeIcon,
} from "@mantine/core";
import { formatFileSize } from "@/lib/notion";

interface FileWithProgress {
  file: FileWithPath;
  progress: number;
  status: "pending" | "uploading" | "completed" | "error";
  phase?: string;
  error?: string;
}

interface UploadProgressData {
  phase?: string;
  progress?: number;
  chunkIndex?: number;
  totalChunks?: number;
  error?: string;
}

export default function FileDropzone() {
  const [files, setFiles] = useState<FileWithProgress[]>([]);
  const [isUploading, setIsUploading] = useState(false);
  const openRef = useRef<() => void>(null);

  const handleDrop = async (acceptedFiles: FileWithPath[]) => {
    const newFiles: FileWithProgress[] = acceptedFiles.map((file) => ({
      file,
      progress: 0,
      status: "pending" as const,
    }));

    setFiles((prev) => [...prev, ...newFiles]);
    setIsUploading(true);

    for (let i = 0; i < newFiles.length; i++) {
      const fileWithProgress = newFiles[i];
      const fileIndex = files.length + i;

      try {
        setFiles((prev) =>
          prev.map((f, idx) =>
            idx === fileIndex ? { ...f, status: "uploading" as const } : f
          )
        );

        const formData = new FormData();
        formData.append("file", fileWithProgress.file);

        const response = await fetch("/api/upload", {
          method: "POST",
          body: formData,
        });

        if (!response.ok) {
          const errorData = await response.json();
          throw new Error(errorData.error || "Upload failed");
        }

        // Use SSE for progress updates
        const reader = response.body?.getReader();
        const decoder = new TextDecoder();

        if (reader) {
          let buffer = "";
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;

            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split("\n");
            buffer = lines.pop() || "";

            for (const line of lines) {
              if (line.startsWith("data: ")) {
                try {
                  const data: UploadProgressData = JSON.parse(line.slice(6));

                  // Check for error in SSE stream
                  if (data.error) {
                    throw new Error(data.error);
                  }

                  setFiles((prev) =>
                    prev.map((f, idx) =>
                      idx === fileIndex
                        ? {
                            ...f,
                            progress: data.progress || 0,
                            phase: getPhaseText(
                              data.phase || "",
                              data.chunkIndex,
                              data.totalChunks
                            ),
                          }
                        : f
                    )
                  );
                } catch (parseError) {
                  if (parseError instanceof Error && parseError.message !== "Unexpected token") {
                    throw parseError;
                  }
                }
              }
            }
          }
        }

        setFiles((prev) =>
          prev.map((f, idx) =>
            idx === fileIndex
              ? { ...f, status: "completed" as const, progress: 100 }
              : f
          )
        );
      } catch (error) {
        setFiles((prev) =>
          prev.map((f, idx) =>
            idx === fileIndex
              ? {
                  ...f,
                  status: "error" as const,
                  error:
                    error instanceof Error ? error.message : "Upload failed",
                }
              : f
          )
        );
      }
    }

    setIsUploading(false);
  };

  const getPhaseText = (
    phase: string,
    chunkIndex?: number,
    totalChunks?: number
  ): string => {
    switch (phase) {
      case "creating":
        return "업로드 준비 중...";
      case "uploading":
        if (chunkIndex && totalChunks) {
          return `업로드 중 (${chunkIndex}/${totalChunks})`;
        }
        return "업로드 중...";
      case "completing":
        return "업로드 완료 처리 중...";
      case "attaching":
        return "Notion에 첨부 중...";
      case "done":
        return "완료!";
      default:
        return "처리 중...";
    }
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
