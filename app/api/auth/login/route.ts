import { NextRequest, NextResponse } from "next/server";
import { createSession, safeStringEqual, SESSION_COOKIE } from "@/lib/auth";
export const runtime = "nodejs";
export async function POST(request: NextRequest) {
  const expected = process.env.CLOUDCLI_PASSWORD;
  if (!expected) return NextResponse.json({ error: "CloudCLI login is not configured." }, { status: 503 });
  let body: { password?: unknown };
  try { body = await request.json(); } catch { return NextResponse.json({ error: "Invalid request body." }, { status: 400 }); }
  const password = typeof body.password === "string" ? body.password : "";
  if (!safeStringEqual(password, expected)) return NextResponse.json({ error: "Incorrect password." }, { status: 401 });
  try {
    const session = createSession();
    const response = NextResponse.json({ authenticated: true });
    response.cookies.set(SESSION_COOKIE, session.value, {
      httpOnly: true, secure: process.env.NODE_ENV === "production", sameSite: "strict",
      path: "/", maxAge: session.maxAge
    });
    return response;
  } catch { return NextResponse.json({ error: "Session signing is not configured." }, { status: 503 }); }
}
