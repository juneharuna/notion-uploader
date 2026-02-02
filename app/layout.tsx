import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import { MantineProvider, ColorSchemeScript } from "@mantine/core";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "Notion File Uploader",
  description: "Upload files to Notion",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="ko" suppressHydrationWarning>
      <head>
        <ColorSchemeScript />
      </head>
      <body
        className={`${geistSans.variable} ${geistMono.variable} antialiased`}
      >
        <MantineProvider>
          {children}
        </MantineProvider>
      </body>
    </html>
  );
}
