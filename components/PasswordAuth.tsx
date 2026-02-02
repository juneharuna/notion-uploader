"use client";

import { useState } from "react";
import {
  Paper,
  TextInput,
  Button,
  Stack,
  Text,
  Title,
  Center,
  Alert,
} from "@mantine/core";

interface PasswordAuthProps {
  onAuthenticated: () => void;
}

export default function PasswordAuth({ onAuthenticated }: PasswordAuthProps) {
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    setLoading(true);

    try {
      const response = await fetch("/api/auth", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ password }),
      });

      if (response.ok) {
        onAuthenticated();
      } else {
        const data = await response.json();
        setError(data.error || "인증 실패");
      }
    } catch {
      setError("서버 오류가 발생했습니다");
    } finally {
      setLoading(false);
    }
  };

  return (
    <Center style={{ minHeight: "100vh" }}>
      <Paper p="xl" shadow="md" radius="md" style={{ width: 340 }}>
        <form onSubmit={handleSubmit}>
          <Stack gap="md">
            <Title order={2} ta="center">
              🔐 Notion Uploader
            </Title>
            <Text size="sm" c="dimmed" ta="center">
              비밀번호를 입력하세요
            </Text>

            {error && (
              <Alert color="red" variant="light">
                {error}
              </Alert>
            )}

            <TextInput
              type="password"
              placeholder="비밀번호"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
              autoFocus
            />

            <Button type="submit" loading={loading} fullWidth>
              로그인
            </Button>
          </Stack>
        </form>
      </Paper>
    </Center>
  );
}
