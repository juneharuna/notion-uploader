"use client";

import { useEffect, useState } from "react";
import { Container, Paper, Center, Loader } from "@mantine/core";
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
      <Paper p="md" withBorder>
        <FileDropzone />
      </Paper>
    </Container>
  );
}
