import { cookies } from "next/headers";
import { isPasswordEnabled, verifyAuthToken } from "@/app/api/auth/route";

export async function requireAuth(): Promise<Response | null> {
  if (!isPasswordEnabled()) return null;

  const cookieStore = await cookies();
  const authToken = cookieStore.get("auth_token");

  if (!authToken || !verifyAuthToken(authToken.value)) {
    return Response.json({ error: "인증이 필요합니다" }, { status: 401 });
  }

  return null;
}
