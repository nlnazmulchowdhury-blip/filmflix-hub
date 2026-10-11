import { sha256 } from "./crypto";

/** PBKDF2-SHA256 password hashing (Web Crypto, OWASP-aligned work factor).
 * .async Format: pbkdf2$<iterations>$<salt-hex>$<hash-hex> — self-describing
 *  so the iteration count can be raised later without breaking old rows. */
const ITERATIONS = 100_000;
const KEY_LEN = 32;

function hex(buf: ArrayBuffer): string {
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export function newSalt(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export async function hashPassword(password: string, salt: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(password),
    "PBKDF2",
    false,
    ["deriveBits"],
  );
  const bits = await crypto.subtle.deriveBits(
    {
      name: "PBKDF2",
      salt: new TextEncoder().encode(salt),
      iterations: ITERATIONS,
      hash: "SHA-256",
    },
    key,
    KEY_LEN * 8,
  );
  return `pbkdf2$${ITERATIONS}$${salt}$${hex(bits)}`;
}

export async function verifyPassword(
  password: string,
  stored: string | null,
): Promise<boolean> {
  if (!stored) return false;
  const [scheme, iterStr, salt, expected] = stored.split("$");
  if (scheme !== "pbkdf2" || !iterStr || !salt || !expected) return false;
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(password),
    "PBKDF2",
    false,
    ["deriveBits"],
  );
  const bits = await crypto.subtle.deriveBits(
    {
      name: "PBKDF2",
      salt: new TextEncoder().encode(salt),
      iterations: Number(iterStr),
      hash: "SHA-256",
    },
    key,
    (expected.length / 2) * 8,
  );
  // Constant-time-ish comparison via a shared hash (hex strings, fixed length).
  const a = await sha256(hex(bits));
  const b = await sha256(expected);
  return a === b;
}

export function newToken(): string {
  return crypto.randomUUID() + "." + crypto.randomUUID();
}

export const SESSION_TTL_SECONDS = 30 * 24 * 3600;
