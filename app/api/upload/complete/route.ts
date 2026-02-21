import { NextRequest, NextResponse } from "next/server";
import { cookies } from "next/headers";
import { list, del } from "@vercel/blob";
import { verifyAuthToken, isPasswordEnabled } from "../../auth/route";
import { attachFileToPage } from "@/lib/notion";
import { streamToNotion } from "@/lib/stream-rechunker";

export const runtime = "nodejs";
export const maxDuration = 800; // Pro plan maximum

async function cleanupBlobChunks(uploadId: string): Promise<void> {
  try {
    const { blobs } = await list({ prefix: `chunks/${uploadId}/` });
    if (blobs.length > 0) {
      await del(blobs.map((b) => b.url));
    }
  } catch (error) {
    console.error("Cleanup error:", error);
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
    const useMultiPart = formData.get("useMultiPart") === "true";

    if (!uploadId || !filename || !totalChunks) {
      return NextResponse.json(
        { error: "필수 파라미터가 누락되었습니다" },
        { status: 400 }
      );
    }

    // 1. List and sort Blob chunks
    const { blobs } = await list({ prefix: `chunks/${uploadId}/` });

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

    // 2. Stream progress via SSE
    const encoder = new TextEncoder();
    const capturedUploadId = uploadId;
    const stream = new ReadableStream({
      async start(controller) {
        const sendEvent = (data: Record<string, unknown>) => {
          controller.enqueue(
            encoder.encode(`data: ${JSON.stringify(data)}\n\n`)
          );
        };

        try {
          sendEvent({ phase: "reading", message: "Blob 청크 읽는 중..." });

          await streamToNotion(
            capturedUploadId,
            sortedBlobs,
            contentType || "application/octet-stream",
            useMultiPart,
            (partNumber, totalParts) => {
              sendEvent({
                phase: "sending",
                partNumber,
                totalParts,
                message: `Notion에 전송 중 (${partNumber}/${totalParts})`,
              });
            }
          );

          sendEvent({ phase: "attaching", message: "페이지에 첨부 중..." });
          await attachFileToPage(capturedUploadId, filename);

          sendEvent({ phase: "cleanup", message: "임시 파일 정리 중..." });
          await cleanupBlobChunks(capturedUploadId);

          sendEvent({
            phase: "done",
            success: true,
            uploadId: capturedUploadId,
          });
          controller.close();
        } catch (error) {
          const errorMessage =
            error instanceof Error ? error.message : "업로드 완료 실패";
          sendEvent({ phase: "error", error: errorMessage });

          // Cleanup on error
          await cleanupBlobChunks(capturedUploadId);

          controller.close();
        }
      },
    });

    return new Response(stream, {
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      },
    });
  } catch (error) {
    console.error("Complete upload error:", error);

    if (uploadId) {
      await cleanupBlobChunks(uploadId);
    }

    return NextResponse.json(
      { error: error instanceof Error ? error.message : "업로드 완료 실패" },
      { status: 422 }
    );
  }
}
