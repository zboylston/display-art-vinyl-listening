import { Redis } from "@upstash/redis";
import {
  DISPLAY_SESSION_TTL_SECONDS,
  generateDisplayCode,
  isDisplayCode,
  normalizeDisplayCode,
  parseDisplaySnapshot,
  type DisplaySnapshot,
} from "./display-snapshot";

function redisCredentials() {
  const url = process.env.UPSTASH_REDIS_REST_URL ?? process.env.KV_REST_API_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN ?? process.env.KV_REST_API_TOKEN;
  if (!url || !token) return null;
  return { url, token };
}

function redis() {
  const credentials = redisCredentials();
  if (!credentials) {
    throw new Error(
      "Display sync needs Upstash Redis. Add KV_REST_API_URL and KV_REST_API_TOKEN (or UPSTASH_REDIS_REST_*).",
    );
  }
  return new Redis(credentials);
}

function sessionKey(code: string) {
  return `display:session:${normalizeDisplayCode(code)}`;
}

export async function createDisplaySession() {
  const client = redis();
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const code = generateDisplayCode();
    const created = await client.set(sessionKey(code), JSON.stringify({ snapshot: null }), {
      nx: true,
      ex: DISPLAY_SESSION_TTL_SECONDS,
    });
    if (created === "OK") return code;
  }
  throw new Error("Could not allocate a display pairing code.");
}

export async function publishDisplaySnapshot(code: string, snapshot: DisplaySnapshot) {
  const normalized = normalizeDisplayCode(code);
  if (!isDisplayCode(normalized)) throw new Error("Invalid display pairing code.");
  const parsed = parseDisplaySnapshot(snapshot);
  if (!parsed) throw new Error("Invalid display snapshot.");
  const client = redis();
  const key = sessionKey(normalized);
  const existing = await client.get(key);
  if (existing === null) throw new Error("Unknown display session. Create a new pairing code.");
  await client.set(key, JSON.stringify({ snapshot: { ...parsed, updatedAt: Date.now() } }), {
    ex: DISPLAY_SESSION_TTL_SECONDS,
  });
}

export async function readDisplaySession(code: string): Promise<{ exists: boolean; snapshot: DisplaySnapshot | null }> {
  const normalized = normalizeDisplayCode(code);
  if (!isDisplayCode(normalized)) throw new Error("Invalid display pairing code.");
  const client = redis();
  const value = await client.get(sessionKey(normalized));
  if (value === null) return { exists: false, snapshot: null };
  const payload =
    typeof value === "string"
      ? (JSON.parse(value) as { snapshot?: unknown })
      : (value as { snapshot?: unknown });
  if (!payload?.snapshot) return { exists: true, snapshot: null };
  return { exists: true, snapshot: parseDisplaySnapshot(payload.snapshot) };
}

export function isDisplayStoreConfigured() {
  return Boolean(redisCredentials());
}
