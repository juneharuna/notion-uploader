import { NextRequest, NextResponse } from "next/server";
import { cookies } from "next/headers";
import { readFile, unlink, readdir } from "fs/promises";
import path from "path";
import { verifyAuthToken, isPasswordEnabled } from "../../auth/route";
import { completeMultiPartUpload, attachFileToPage, sendFileData } from "@/lib/notion";

export const runtime = "nodejs";
export const maxDuration = 300; // 5 minutes for large files

const TEMP_DIR = "/tmp/notion-uploads";

export async function POST(request: NextRequest) {
  // Check authentication
  if (isPasswordEnabled()) {
    const cookieStore = await cookies();
    const authToken = cookieStore.get("auth_token");

    if (!authToken || !verifyAuthToken(authToken.value)) {
      return NextResponse.json({ error: "인증이 필요합니다" }, { status: 401 });
    }
  }

  // Check environment variables
  if (!process.env.NOTION_API_KEY || !process.env.NOTION_PAGE_ID) {
    return NextResponse.json(
      { error: "Notion API 설정이 필요합니다" },
      { status: 500 }
    );
  }

  try {
    const formData = await request.formData();
    const uploadId = formData.get("uploadId") as string;
    const filename = formData.get("filename") as string;
    const contentType = formData.get("contentType") as string;
    const useMultiPart = formData.get("useMultiPart") === "true";
    const totalChunks = parseInt(formData.get("totalChunks") as string, 10);

    if (!uploadId || !filename || !totalChunks) {
      return NextResponse.json(
        { error: "필수 파라미터가 누락되었습니다" },
        { status: 400 }
      );
    }

    if (useMultiPart) {
      // Multi-part upload: chunks were already sent to Notion, just complete
      await completeMultiPartUpload(uploadId);
    } else {
      // Single-part upload: read chunks from /tmp and combine
      const chunks: Buffer[] = [];

      for (let i = 1; i <= totalChunks; i++) {
        const chunkPath = path.join(TEMP_DIR, `${uploadId}_${i}`);
        try {
          const chunkData = await readFile(chunkPath);
          chunks.push(chunkData);
        } catch (err) {
          console.error(`Failed to read chunk ${i}:`, err);
          throw new Error(`청크 ${i}을(를) 찾을 수 없습니다. 다시 시도해주세요.`);
        }
      }

      // Combine all chunks
      const combinedBuffer = Buffer.concat(chunks);

      // Send combined file to Notion
      await sendFileData(
        uploadId,
        combinedBuffer,
        contentType || "application/octet-stream"
      );

      // Clean up temp files
      for (let i = 1; i <= totalChunks; i++) {
        const chunkPath = path.join(TEMP_DIR, `${uploadId}_${i}`);
        try {
          await unlink(chunkPath);
        } catch {
          // Ignore cleanup errors
        }
      }
    }

    // Attach file to Notion page
    await attachFileToPage(uploadId, filename);

    return NextResponse.json({
      success: true,
      uploadId,
    });
  } catch (error) {
    console.error("Complete upload error:", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "업로드 완료 실패" },
      { status: 500 }
    );
  }
}
