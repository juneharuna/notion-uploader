import { NextRequest } from "next/server";
import { cookies } from "next/headers";
import { verifyAuthToken, isPasswordEnabled } from "../auth/route";
import { uploadFileToNotion } from "@/lib/notion";

export const runtime = "nodejs";
export const maxDuration = 300; // 5 minutes for large files

export async function POST(request: NextRequest) {
  // Check authentication (skip if password not set)
  if (isPasswordEnabled()) {
    const cookieStore = await cookies();
    const authToken = cookieStore.get("auth_token");

    if (!authToken || !verifyAuthToken(authToken.value)) {
      return new Response(JSON.stringify({ error: "인증이 필요합니다" }), {
        status: 401,
        headers: { "Content-Type": "application/json" },
      });
    }
  }

  // Check environment variables
  if (!process.env.NOTION_API_KEY || !process.env.NOTION_PAGE_ID) {
    return new Response(
      JSON.stringify({ error: "Notion API 설정이 필요합니다" }),
      { status: 500, headers: { "Content-Type": "application/json" } }
    );
  }

  try {
    const formData = await request.formData();
    const file = formData.get("file") as File;

    if (!file) {
      return new Response(JSON.stringify({ error: "파일이 없습니다" }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      });
    }

    const filename = file.name;
    const contentType = file.type || "application/octet-stream";
    const arrayBuffer = await file.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);

    // Create a readable stream for SSE
    const encoder = new TextEncoder();
    const stream = new ReadableStream({
      async start(controller) {
        try {
          await uploadFileToNotion(filename, contentType, buffer, (progress) => {
            const data = `data: ${JSON.stringify(progress)}\n\n`;
            controller.enqueue(encoder.encode(data));
          });

          controller.close();
        } catch (error) {
          const errorMessage =
            error instanceof Error ? error.message : "Upload failed";
          const errorData = `data: ${JSON.stringify({ error: errorMessage })}\n\n`;
          controller.enqueue(encoder.encode(errorData));
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
    console.error("Upload error:", error);
    return new Response(
      JSON.stringify({
        error: error instanceof Error ? error.message : "업로드 실패",
      }),
      { status: 500, headers: { "Content-Type": "application/json" } }
    );
  }
}
