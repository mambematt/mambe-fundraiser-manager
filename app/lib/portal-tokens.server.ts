// Random tokens for portal login links and sessions. Only SHA-256 hashes are stored.
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

/** 32 random bytes, URL-safe. */
export function newToken(): string {
  return randomBytes(32).toString("base64url");
}

export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export function hashKey(kind: string, value: string): string {
  return `${kind}:${createHash("sha256").update(value.trim().toLowerCase()).digest("hex")}`;
}

export function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}
