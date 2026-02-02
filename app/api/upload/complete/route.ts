import { NextRequest, NextResponse } from "next/server";
import { cookies } from "next/headers";
import { verifyAuthToken, isPasswordEnabled } from "../../auth/route";
import { completeMultiPartUpload, attachFileToPage } from "@/lib/notion";

export const runtime = "nodejs";
export const maxDuration = 60;

interface CompleteRequest {
  uploadId: string;
  filename: string;
  totalChunks: number;
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

  // Check environment variables
  if (!process.env.NOTION_API_KEY || !process.env.NOTION_PAGE_ID) {
    return NextResponse.json(
      { error: "Notion API 설정이 필요합니다" },
      { status: 500 }
    );
  }

  try {
    const body: CompleteRequest = await request.json();
    const { uploadId, filename, totalChunks } = body;

    if (!uploadId || !filename) {
      return NextResponse.json(
        { error: "필수 파라미터가 누락되었습니다" },
        { status: 400 }
      );
    }

    // Complete multi-part upload if there were multiple chunks
    if (totalChunks > 1) {
      await completeMultiPartUpload(uploadId);
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
