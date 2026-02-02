import { NextRequest, NextResponse } from "next/server";
import { cookies } from "next/headers";
import { verifyAuthToken, isPasswordEnabled } from "../../auth/route";
import { createFileUpload } from "@/lib/notion";

export const runtime = "nodejs";

const NOTION_MULTIPART_THRESHOLD = 20 * 1024 * 1024; // 20MB

interface InitRequest {
  filename: string;
  contentType: string;
  fileSize: number;
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
    const body: InitRequest = await request.json();
    const { filename, contentType, fileSize, totalChunks } = body;

    if (!filename || !contentType || !fileSize || !totalChunks) {
      return NextResponse.json(
        { error: "필수 파라미터가 누락되었습니다" },
        { status: 400 }
      );
    }

    // Notion only supports multi_part for files > 20MB
    const useMultiPart = fileSize > NOTION_MULTIPART_THRESHOLD;

    // Calculate number of parts for Notion (10MB chunks for multi-part)
    const notionChunkSize = 10 * 1024 * 1024;
    const notionParts = useMultiPart ? Math.ceil(fileSize / notionChunkSize) : undefined;

    const uploadObj = await createFileUpload(
      filename,
      contentType,
      useMultiPart,
      notionParts
    );

    return NextResponse.json({
      uploadId: uploadObj.id,
      filename,
      fileSize,
      totalChunks,
      useMultiPart,
    });
  } catch (error) {
    console.error("Init upload error:", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "업로드 초기화 실패" },
      { status: 500 }
    );
  }
}
