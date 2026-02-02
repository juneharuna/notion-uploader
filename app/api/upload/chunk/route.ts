import { NextRequest, NextResponse } from "next/server";
import { cookies } from "next/headers";
import { put } from "@vercel/blob";
import { verifyAuthToken, isPasswordEnabled } from "../../auth/route";
import { sendFileData } from "@/lib/notion";

export const runtime = "nodejs";
export const maxDuration = 60;

export async function POST(request: NextRequest) {
  // Check authentication
  if (isPasswordEnabled()) {
    const cookieStore = await cookies();
    const authToken = cookieStore.get("auth_token");

    if (!authToken || !verifyAuthToken(authToken.value)) {
      return NextResponse.json({ error: "인증이 필요합니다" }, { status: 401 });
    }
  }

  if (!process.env.NOTION_API_KEY) {
    return NextResponse.json(
      { error: "Notion API 설정이 필요합니다" },
      { status: 500 }
    );
  }

  try {
    const formData = await request.formData();
    const chunk = formData.get("chunk") as File;
    const uploadId = formData.get("uploadId") as string;
    const partNumber = formData.get("partNumber") as string;
    const contentType = formData.get("contentType") as string;
    const useMultiPart = formData.get("useMultiPart") === "true";

    if (!chunk || !uploadId || !partNumber) {
      return NextResponse.json(
        { error: "필수 파라미터가 누락되었습니다" },
        { status: 400 }
      );
    }

    const arrayBuffer = await chunk.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);
    const partNum = parseInt(partNumber, 10);

    if (useMultiPart) {
      // For multi-part uploads (files > 20MB), send directly to Notion
      await sendFileData(
        uploadId,
        buffer,
        contentType || "application/octet-stream",
        partNum
      );
    } else {
      // For single-part uploads, save chunk to Vercel Blob
      const blobPath = `chunks/${uploadId}/${partNum}`;
      await put(blobPath, buffer, {
        access: "public",
        addRandomSuffix: false,
      });
    }

    return NextResponse.json({
      success: true,
      uploadId,
      partNumber: partNum,
      useMultiPart,
    });
  } catch (error) {
    console.error("Chunk upload error:", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "청크 업로드 실패" },
      { status: 500 }
    );
  }
}
