import { NextResponse } from "next/server";
import { SESSION_COOKIE } from "@/lib/auth";
export const runtime = "nodejs";
export async function POST() {
  const response = NextResponse.json({ authenticated: false });
  response.cookies.set(SESSION_COOKIE, "", {
    httpOnly: true, secure: process.env.NODE_ENV === "production", sameSite: "strict",
    path: "/", maxAge: 0
  });
  return response;
}
