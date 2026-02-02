import { NextRequest, NextResponse } from "next/server";
import { cookies } from "next/headers";

const UPLOAD_PASSWORD = process.env.UPLOAD_PASSWORD;

// 비밀번호가 설정되어 있는지 확인
export function isPasswordEnabled(): boolean {
  return !!UPLOAD_PASSWORD && UPLOAD_PASSWORD.trim() !== "";
}

export async function POST(request: NextRequest) {
  // 비밀번호가 설정되지 않았으면 항상 인증 성공
  if (!isPasswordEnabled()) {
    return NextResponse.json({ success: true });
  }

  try {
    const { password } = await request.json();

    if (password === UPLOAD_PASSWORD) {
      // Set auth cookie (valid for 7 days)
      const cookieStore = await cookies();
      cookieStore.set("auth_token", createAuthToken(), {
        httpOnly: true,
        secure: process.env.NODE_ENV === "production",
        sameSite: "strict",
        maxAge: 60 * 60 * 24 * 7, // 7 days
      });

      return NextResponse.json({ success: true });
    }

    return NextResponse.json({ error: "비밀번호가 틀렸습니다" }, { status: 401 });
  } catch {
    return NextResponse.json({ error: "잘못된 요청입니다" }, { status: 400 });
  }
}

export async function GET() {
  // 비밀번호가 설정되지 않았으면 항상 인증됨
  if (!isPasswordEnabled()) {
    return NextResponse.json({ authenticated: true });
  }

  const cookieStore = await cookies();
  const authToken = cookieStore.get("auth_token");

  if (authToken && verifyAuthToken(authToken.value)) {
    return NextResponse.json({ authenticated: true });
  }

  return NextResponse.json({ authenticated: false }, { status: 401 });
}

// Simple token generation/verification
function createAuthToken(): string {
  const timestamp = Date.now().toString(36);
  const secret = UPLOAD_PASSWORD || "";
  const hash = simpleHash(timestamp + secret);
  return `${timestamp}.${hash}`;
}

export function verifyAuthToken(token: string): boolean {
  const parts = token.split(".");
  if (parts.length !== 2) return false;

  const [timestamp, hash] = parts;
  const secret = UPLOAD_PASSWORD || "";
  const expectedHash = simpleHash(timestamp + secret);

  if (hash !== expectedHash) return false;

  // Check if token is expired (7 days)
  const tokenTime = parseInt(timestamp, 36);
  const now = Date.now();
  const sevenDays = 60 * 60 * 24 * 7 * 1000;

  return now - tokenTime < sevenDays;
}

function simpleHash(str: string): string {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    const char = str.charCodeAt(i);
    hash = (hash << 5) - hash + char;
    hash = hash & hash;
  }
  return Math.abs(hash).toString(36);
}
