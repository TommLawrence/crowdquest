import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";

export interface DeployedIdentity { id: string; login: string; displayName: string }
export interface DeployedSession extends DeployedIdentity { expiresAt: number }
export interface OAuthState { nonce: string; role: "broadcaster" | "chatReader"; streamerId: string | null; expiresAt: number }

const SESSION_COOKIE = "cq_session";
const STATE_COOKIES = { broadcaster: "cq_oauth_state", chatReader: "cq_bot_oauth_state" } as const;
const MAX_AGE_SECONDS = 12 * 60 * 60;
const STATE_LIFETIME_MS = 10 * 60 * 1_000;

export function beginOAuth(role: OAuthState["role"], streamerId: string | null, response: ServerResponse, now = Date.now()): string {
  const nonce = randomBytes(32).toString("base64url");
  const state: OAuthState = { nonce, role, streamerId, expiresAt: now + STATE_LIFETIME_MS };
  setCookie(response, STATE_COOKIES[role], signValue(state), callbackPath(role), 600);
  return nonce;
}

export function verifyOAuth(request: IncomingMessage, queryState: string, role: OAuthState["role"], streamerId: string | null, now = Date.now()): boolean {
  const state = verifyValue<OAuthState>(readCookie(request, STATE_COOKIES[role]));
  return Boolean(state && state.role === role && state.nonce === queryState && state.expiresAt >= now && state.streamerId === streamerId);
}

export function clearOAuthState(response: ServerResponse, role: OAuthState["role"]): void {
  setCookie(response, STATE_COOKIES[role], "", callbackPath(role), 0);
}

export function setStreamerSession(response: ServerResponse, identity: DeployedIdentity): void {
  const session: DeployedSession = { ...identity, expiresAt: Date.now() + MAX_AGE_SECONDS * 1_000 };
  setCookie(response, SESSION_COOKIE, signValue(session), "/", MAX_AGE_SECONDS);
}

export function readStreamerSession(request: IncomingMessage, now = Date.now()): DeployedSession | null {
  const session = verifyValue<DeployedSession>(readCookie(request, SESSION_COOKIE));
  if (!session || !isIdentity(session) || !Number.isSafeInteger(session.expiresAt) || session.expiresAt < now) return null;
  return session;
}

export function clearStreamerSession(response: ServerResponse): void {
  setCookie(response, SESSION_COOKIE, "", "/", 0);
}

export function getCookie(request: IncomingMessage, name: string): string | null {
  return readCookie(request, name);
}

export function sameOrigin(request: IncomingMessage): boolean {
  const origin = request.headers.origin;
  const redirectUri = process.env.TWITCH_REDIRECT_URI;
  if (!origin || !redirectUri) return false;
  try { return origin === new URL(redirectUri).origin; }
  catch { return false; }
}

function signValue(value: object): string {
  const secret = sessionSecret();
  const payload = Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${payload}.${createHmac("sha256", secret).update(payload).digest("base64url")}`;
}

function verifyValue<T>(value: string | null): T | null {
  if (!value) return null;
  const [payload, signature, extra] = value.split(".");
  if (!payload || !signature || extra !== undefined) return null;
  try {
    const expected = createHmac("sha256", sessionSecret()).update(payload).digest();
    const supplied = Buffer.from(signature, "base64url");
    if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) return null;
    return JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as T;
  } catch {
    return null;
  }
}

function sessionSecret(): Buffer {
  const secret = Buffer.from(process.env.SESSION_SECRET ?? "", "utf8");
  if (secret.length < 32) throw new Error("SESSION_SECRET must contain at least 32 bytes.");
  return secret;
}

function readCookie(request: IncomingMessage, name: string): string | null {
  for (const part of (request.headers.cookie ?? "").split(";")) {
    const separator = part.indexOf("=");
    if (separator < 0 || part.slice(0, separator).trim() !== name) continue;
    try { return decodeURIComponent(part.slice(separator + 1).trim()); }
    catch { return null; }
  }
  return null;
}

function setCookie(response: ServerResponse, name: string, value: string, path: string, maxAge: number): void {
  const cookie = [`${name}=${encodeURIComponent(value)}`, `Path=${path}`, `Max-Age=${maxAge}`, "HttpOnly", "SameSite=Lax"];
  if (process.env.NODE_ENV === "production") cookie.push("Secure");
  const existing = response.getHeader("set-cookie");
  const cookies = Array.isArray(existing) ? existing : typeof existing === "string" ? [existing] : [];
  response.setHeader("set-cookie", [...cookies, cookie.join("; ")]);
}

function callbackPath(role: OAuthState["role"]): string {
  const value = role === "broadcaster" ? process.env.TWITCH_REDIRECT_URI : process.env.TWITCH_BOT_REDIRECT_URI;
  try { return new URL(value ?? "").pathname; }
  catch { return "/api/twitch/callback"; }
}

function isIdentity(value: DeployedSession): boolean {
  return typeof value.id === "string" && value.id.length > 0 && typeof value.login === "string" && typeof value.displayName === "string";
}
