"use client";

import { useEffect, useState } from "react";
import { Container, Title, Text, Stack, Paper, Center, Loader } from "@mantine/core";
import FileDropzone from "@/components/FileDropzone";
import PasswordAuth from "@/components/PasswordAuth";

export default function Home() {
  const [isAuthenticated, setIsAuthenticated] = useState<boolean | null>(null);

  useEffect(() => {
    // Check if already authenticated
    fetch("/api/auth")
      .then((res) => res.json())
      .then((data) => setIsAuthenticated(data.authenticated))
      .catch(() => setIsAuthenticated(false));
  }, []);

  // Loading state
  if (isAuthenticated === null) {
    return (
      <Center style={{ minHeight: "100vh" }}>
        <Loader size="lg" />
      </Center>
    );
  }

  // Not authenticated - show login
  if (!isAuthenticated) {
    return <PasswordAuth onAuthenticated={() => setIsAuthenticated(true)} />;
  }

  // Authenticated - show uploader
  return (
    <Container size="sm" py="xl">
      <Stack gap="lg">
        <div>
          <Title order={1} ta="center" mb="xs">
            Notion File Uploader
          </Title>
          <Text ta="center" c="dimmed" size="sm">
            파일을 업로드하면 Notion 페이지에 자동으로 첨부됩니다
          </Text>
        </div>

        <Paper p="md" withBorder>
          <FileDropzone />
        </Paper>

        <Text size="xs" c="dimmed" ta="center">
          최대 5GB 파일 업로드 지원 (Notion 유료 플랜)
        </Text>
      </Stack>
    </Container>
  );
}
