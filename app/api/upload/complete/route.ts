import { NextRequest, NextResponse } from "next/server";
import { cookies } from "next/headers";
import { list, del } from "@vercel/blob";
import { verifyAuthToken, isPasswordEnabled } from "../../auth/route";
import { completeMultiPartUpload, attachFileToPage, sendFileData } from "@/lib/notion";

export const runtime = "nodejs";
export const maxDuration = 300;

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
      // Multi-part upload: chunks were already sent to Notion
      await completeMultiPartUpload(uploadId);
    } else {
      // Single-part upload: read chunks from Vercel Blob and combine
      const chunks: Buffer[] = [];
      const blobUrls: string[] = [];

      // List and fetch all chunks
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

      // Combine all chunks
      const combinedBuffer = Buffer.concat(chunks);

      // Send combined file to Notion
      await sendFileData(
        uploadId,
        combinedBuffer,
        contentType || "application/octet-stream"
      );

      // Clean up blobs
      if (blobUrls.length > 0) {
        await del(blobUrls);
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
