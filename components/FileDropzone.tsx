"use client";

import { useRef } from "react";
import { Dropzone } from "@mantine/dropzone";
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
import { formatFileSize } from "@/lib/format";
import { useFileUpload } from "@/hooks/useFileUpload";
import { UploadIcon, XIcon, FileIcon } from "./icons";

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

export default function FileDropzone() {
  const { files, isUploading, handleDrop, clearCompleted } = useFileUpload();
  const openRef = useRef<() => void>(null);

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
              파일 크기 제한: 5GB
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
