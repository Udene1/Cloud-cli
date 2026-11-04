import { NextRequest, NextResponse } from "next/server";
import { createSession, safeStringEqual, SESSION_COOKIE } from "@/lib/auth";

export const runtime = "nodejs";

// Best-effort per-instance protection. Use a shared rate-limit store or Vercel
// Firewall before exposing this login endpoint to a wider audience.
const WINDOW_MS = 15 * 60 * 1000;
const MAX_FAILURES = 5;
const attempts = new Map<string, { failures: number; resetAt: number }>();

function clientKey(request: NextRequest) {
  return request.headers.get("x-real-ip")
    || request.headers.get("x-forwarded-for")?.split(",")[0]?.trim()
    || "unknown";
}

function prune(now: number) {
  for (const [key, value] of attempts) {
    if (value.resetAt <= now) attempts.delete(key);
  }
  // Bound memory use if an endpoint is hit by many distinct addresses.
  while (attempts.size > 5000) {
    const oldest = attempts.keys().next().value;
    if (!oldest) break;
    attempts.delete(oldest);
  }
}

export async function POST(request: NextRequest) {
  const expected = process.env.CLOUDCLI_PASSWORD;
  if (!expected) return NextResponse.json({ error: "CloudCLI login is not configured." }, { status: 503 });

  const now = Date.now();
  prune(now);
  const key = clientKey(request);
  const current = attempts.get(key);
  if (current && current.resetAt > now && current.failures >= MAX_FAILURES) {
    return NextResponse.json(
      { error: "Too many unsuccessful attempts. Try again in 15 minutes." },
      { status: 429, headers: { "Retry-After": String(Math.ceil((current.resetAt - now) / 1000)) } }
    );
  }

  const length = Number(request.headers.get("content-length") || 0);
  if (length > 4096) return NextResponse.json({ error: "Request is too large." }, { status: 413 });

  let body: { password?: unknown };
  try { body = await request.json(); }
  catch { return NextResponse.json({ error: "Invalid request body." }, { status: 400 }); }

  const password = typeof body.password === "string" ? body.password : "";
  if (!safeStringEqual(password, expected)) {
    const state = current && current.resetAt > now
      ? current
      : { failures: 0, resetAt: now + WINDOW_MS };
    state.failures += 1;
    attempts.set(key, state);
    return NextResponse.json({ error: "Incorrect password." }, { status: 401 });
  }

  attempts.delete(key);
  try {
    const session = createSession();
    const response = NextResponse.json({ authenticated: true });
    response.cookies.set(SESSION_COOKIE, session.value, {
      httpOnly: true,
      secure: true,
      sameSite: "strict",
      path: "/",
      maxAge: session.maxAge
    });
    response.headers.set("Cache-Control", "no-store");
    return response;
  } catch {
    return NextResponse.json({ error: "Session signing is not configured." }, { status: 503 });
  }
}
