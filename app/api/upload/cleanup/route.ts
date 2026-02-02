import { NextRequest, NextResponse } from "next/server";
import { cookies } from "next/headers";
import { list, del } from "@vercel/blob";
import { verifyAuthToken, isPasswordEnabled } from "../../auth/route";

export const runtime = "nodejs";

export async function POST(request: NextRequest) {
  // Check authentication
  if (isPasswordEnabled()) {
    const cookieStore = await cookies();
    const authToken = cookieStore.get("auth_token");

    if (!authToken || !verifyAuthToken(authToken.value)) {
      return NextResponse.json({ error: "인증이 필요합니다" }, { status: 401 });
    }
  }

  try {
    const { uploadId } = await request.json();

    if (!uploadId) {
      return NextResponse.json(
        { error: "uploadId가 필요합니다" },
        { status: 400 }
      );
    }

    const deletedCount = await cleanupBlobChunks(uploadId);

    return NextResponse.json({
      success: true,
      uploadId,
      deletedCount,
    });
  } catch (error) {
    console.error("Cleanup error:", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "정리 실패" },
      { status: 500 }
    );
  }
}

// Cleanup function that can be exported for use in other routes
export async function cleanupBlobChunks(uploadId: string): Promise<number> {
  const { blobs } = await list({ prefix: `chunks/${uploadId}/` });

  if (blobs.length > 0) {
    await del(blobs.map((b) => b.url));
  }

  return blobs.length;
}
