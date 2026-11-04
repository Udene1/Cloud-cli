import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
export const SESSION_COOKIE = "cloudcli_session";
const TTL = 60 * 60 * 12;
function secret() {
  const value = process.env.CLOUDCLI_SESSION_SECRET;
  if (!value || value.length < 32) throw new Error("CLOUDCLI_SESSION_SECRET is not configured.");
  return value;
}
export function safeStringEqual(left: string, right: string) {
  const a = Buffer.from(left), b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}
export function createSession() {
  const issued = Date.now().toString();
  const nonce = randomBytes(18).toString("base64url");
  const payload = issued + "." + nonce;
  const signature = createHmac("sha256", secret()).update(payload).digest("base64url");
  return { value: payload + "." + signature, maxAge: TTL };
}
export function verifySession(value?: string) {
  if (!value) return false;
  const parts = value.split(".");
  if (parts.length !== 3) return false;
  const issued = Number(parts[0]);
  if (!Number.isFinite(issued) || Date.now() - issued < 0 || Date.now() - issued > TTL * 1000) return false;
  try {
    const expected = createHmac("sha256", secret()).update(parts[0] + "." + parts[1]).digest("base64url");
    return safeStringEqual(parts[2], expected);
  } catch { return false; }
}
export function isAuthenticated(request: Request) {
  const raw = request.headers.get("cookie") || "";
  const item = raw.split(";").map((x) => x.trim()).find((x) => x.startsWith(SESSION_COOKIE + "="));
  return verifySession(item ? decodeURIComponent(item.slice(SESSION_COOKIE.length + 1)) : undefined);
}
