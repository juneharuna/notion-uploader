import { NextRequest, NextResponse } from "next/server";
import { cookies } from "next/headers";
import { list, del } from "@vercel/blob";
import { verifyAuthToken, isPasswordEnabled } from "../../auth/route";
import {
  completeMultiPartUpload,
  attachFileToPage,
  sendFileData,
} from "@/lib/notion";

export const runtime = "nodejs";
export const maxDuration = 800; // Pro plan maximum

const NOTION_CHUNK_SIZE = 10 * 1024 * 1024; // 10MB (Notion multi-part chunk size)

async function cleanupBlobChunks(uploadId: string): Promise<void> {
  try {
    const { blobs } = await list({ prefix: `chunks/${uploadId}/` });
    if (blobs.length > 0) {
      await del(blobs.map((b) => b.url));
    }
  } catch (error) {
    console.error("Cleanup error:", error);
    // Don't throw - cleanup failure shouldn't fail the entire operation
  }
}

export async function POST(request: NextRequest) {
  // Check authentication
  if (isPasswordEnabled()) {
    const cookieStore = await cookies();
    const authToken = cookieStore.get("auth_token");

    if (!authToken || !verifyAuthToken(authToken.value)) {
      return NextResponse.json({ error: "인증이 필요합니다" }, { status: 401 });
    }
  }

  if (!process.env.NOTION_API_KEY || !process.env.NOTION_PAGE_ID) {
    return NextResponse.json(
      { error: "Notion API 설정이 필요합니다" },
      { status: 500 }
    );
  }

  let uploadId: string | null = null;

  try {
    const formData = await request.formData();
    uploadId = formData.get("uploadId") as string;
    const filename = formData.get("filename") as string;
    const contentType = formData.get("contentType") as string;
    const totalChunks = parseInt(formData.get("totalChunks") as string, 10);
    // Use the same multi-part decision from init to ensure consistency
    const useMultiPart = formData.get("useMultiPart") === "true";

    if (!uploadId || !filename || !totalChunks) {
      return NextResponse.json(
        { error: "필수 파라미터가 누락되었습니다" },
        { status: 400 }
      );
    }

    // 1. Read all chunks from Vercel Blob
    const chunks: Buffer[] = [];
    const blobUrls: string[] = [];

    const { blobs } = await list({ prefix: `chunks/${uploadId}/` });

    // Sort by part number
    const sortedBlobs = blobs.sort((a, b) => {
      const partA = parseInt(a.pathname.split("/").pop() || "0", 10);
      const partB = parseInt(b.pathname.split("/").pop() || "0", 10);
      return partA - partB;
    });

    if (sortedBlobs.length !== totalChunks) {
      throw new Error(
        `청크 수가 일치하지 않습니다. 예상: ${totalChunks}, 실제: ${sortedBlobs.length}`
      );
    }

    // Fetch each chunk
    for (const blob of sortedBlobs) {
      const response = await fetch(blob.url);
      const arrayBuffer = await response.arrayBuffer();
      chunks.push(Buffer.from(arrayBuffer));
      blobUrls.push(blob.url);
    }

    // 2. Combine all chunks
    const combinedBuffer = Buffer.concat(chunks);
    const fileSize = combinedBuffer.length;

    if (useMultiPart) {
      // Multi-part upload: split into 10MB parts and send to Notion
      const numberOfParts = Math.ceil(fileSize / NOTION_CHUNK_SIZE);

      for (let i = 0; i < numberOfParts; i++) {
        const start = i * NOTION_CHUNK_SIZE;
        const end = Math.min(start + NOTION_CHUNK_SIZE, fileSize);
        const partBuffer = combinedBuffer.subarray(start, end);

        await sendFileData(
          uploadId,
          partBuffer,
          contentType || "application/octet-stream",
          i + 1 // part_number is 1-indexed
        );
      }

      // Complete multi-part upload
      await completeMultiPartUpload(uploadId);
    } else {
      // Single-part upload: send entire file without part_number
      await sendFileData(
        uploadId,
        combinedBuffer,
        contentType || "application/octet-stream"
      );
    }

    // 4. Attach file to Notion page
    await attachFileToPage(uploadId, filename);

    // 5. Clean up Vercel Blob chunks (always cleanup on success)
    await cleanupBlobChunks(uploadId);

    return NextResponse.json({
      success: true,
      uploadId,
    });
  } catch (error) {
    console.error("Complete upload error:", error);

    // Cleanup on error as well
    if (uploadId) {
      await cleanupBlobChunks(uploadId);
    }

    return NextResponse.json(
      { error: error instanceof Error ? error.message : "업로드 완료 실패" },
      { status: 500 }
    );
  }
}
