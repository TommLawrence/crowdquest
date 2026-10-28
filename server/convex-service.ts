import { ConvexHttpClient } from "convex/browser";
import { api } from "../convex/_generated/api.js";
import type { PublicAppState, TwitchStatus } from "../src/client/state.js";

export interface StoredCredential {
  role: "broadcaster" | "chatReader";
  identity: { id: string; login: string; displayName: string };
  encryptedTokens: string;
  scopes: string[];
}

export interface StoredTokens {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
  scopes: string[];
  role: "broadcaster" | "chatReader";
  identity: { id: string; login: string; displayName: string };
}

export async function getPublicStatus(): Promise<TwitchStatus> {
  const status = await client().query(api.state.publicStatus, {}) as TwitchStatus;
  return { ...status, authenticatedSession: false, sessionMode: null, latestCommand: null, error: status.eventSub.error };
}

export async function getPublicState(): Promise<PublicAppState> {
  return await client().query(api.state.publicState, {}) as PublicAppState;
}

export async function getTwitchIdentities(): Promise<{
  broadcaster: { id: string; login: string; displayName: string } | null;
  chatReader: { id: string; login: string; displayName: string } | null;
}> {
  return await internalPost("/internal/identities", {});
}

export async function getCredential(key: "broadcaster" | "chatReader"): Promise<StoredCredential | null> {
  return await internalPost<StoredCredential | null>("/internal/credential/get", { key });
}

export async function storeCredential(input: {
  key: "broadcaster" | "chatReader";
  role: "broadcaster" | "chatReader";
  identity: StoredCredential["identity"];
  encryptedTokens: string;
  scopes: string[];
}): Promise<void> {
  await internalPost("/internal/credential/store", input);
}

export async function clearCredential(key: "broadcaster" | "chatReader", role: "broadcaster" | "chatReader"): Promise<void> {
  await internalPost("/internal/credential/clear", { key, role });
}

export async function invokeChallengeAction(streamerId: string, action: unknown): Promise<{ accepted: boolean; error?: string; revision: number }> {
  return await internalPost("/internal/action", { streamerId, action });
}

export async function setTwitchStatus(input: { connection: "stopped" | "connecting" | "connected" | "error"; subscription: "none" | "pending" | "enabled" | "revoked" | "error"; error: string | null }): Promise<void> {
  await internalPost("/internal/status", input);
}

async function internalPost<T = unknown>(path: string, body: unknown): Promise<T> {
  const secret = process.env.CONVEX_SERVICE_SECRET ?? "";
  const url = process.env.CONVEX_SITE_URL ?? "";
  if (secret.length < 32 || !isHttpsUrl(url)) throw new Error("Convex server configuration is incomplete.");
  const response = await fetch(new URL(path, url), {
    method: "POST",
    headers: { authorization: `Bearer ${secret}`, "content-type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(8_000),
  });
  if (!response.ok) throw new Error("Convex could not complete the server operation.");
  return await response.json() as T;
}

function client(): ConvexHttpClient {
  const url = process.env.CONVEX_URL ?? "";
  if (!isHttpsUrl(url)) throw new Error("CONVEX_URL is not configured.");
  return new ConvexHttpClient(url);
}

function isHttpsUrl(value: string): boolean {
  try { return new URL(value).protocol === "https:"; }
  catch { return false; }
}
