import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { TwitchApi, TwitchApiError } from "./twitch-api.js";
import { clearCredential, getCredential, setTwitchStatus, storeCredential, type StoredTokens } from "./convex-service.js";
import type { DeployedIdentity } from "./deployed-session.js";

const BROADCASTER_SCOPES = ["channel:bot"];
const CHAT_READER_SCOPES = ["user:read:chat", "user:bot"];

export async function completeTwitchAuthorization(code: string, role: "broadcaster" | "chatReader"): Promise<DeployedIdentity> {
  const api = twitchApi(role);
  const response = await api.exchangeCode(code);
  if (!response.refreshToken) throw new Error("Twitch authorization did not include a refresh token.");
  const validation = await api.validateAccessToken(response.accessToken);
  if (validation.clientId !== requiredEnv("TWITCH_CLIENT_ID")) throw new Error("Twitch authorization belongs to a different application.");
  const required = role === "broadcaster" ? BROADCASTER_SCOPES : CHAT_READER_SCOPES;
  if (!required.every((scope) => validation.scopes.includes(scope))) throw new Error("Twitch did not grant the required chat permissions.");
  const identity = await api.getAuthorizedUser(response.accessToken);
  if (identity.id !== validation.userId || identity.login.toLowerCase() !== validation.login.toLowerCase()) throw new Error("Twitch identity validation failed.");
  if (role === "chatReader") {
    const broadcaster = await getCredential("broadcaster");
    if (broadcaster?.identity.id === identity.id) throw new Error("Choose a separate Twitch account for the chat reader.");
  }
  const stored: StoredTokens = {
    accessToken: response.accessToken,
    refreshToken: response.refreshToken,
    expiresAt: Date.now() + response.expiresIn * 1_000,
    scopes: validation.scopes,
    role,
    identity,
  };
  await storeCredential({
    key: role === "broadcaster" ? "broadcaster" : "chatReader",
    role,
    identity,
    encryptedTokens: encryptTokens(stored),
    scopes: validation.scopes,
  });
  await setTwitchStatus({ connection: "connecting", subscription: "pending", error: null });
  await ensureChatSubscription();
  return identity;
}

export async function validateStoredCredential(role: "broadcaster" | "chatReader", expectedId: string): Promise<DeployedIdentity> {
  const key = role === "broadcaster" ? "broadcaster" : "chatReader";
  const credential = await getCredential(key);
  if (!credential || credential.role !== role || credential.identity.id !== expectedId) throw new Error("Twitch session is not authorized.");
  let tokens = decryptTokens(credential.encryptedTokens);
  const api = twitchApi(role);
  try {
    tokens = await refreshIfNeeded(api, tokens);
    const validation = await api.validateAccessToken(tokens.accessToken);
    if (validation.clientId !== requiredEnv("TWITCH_CLIENT_ID") || validation.userId !== expectedId) throw new Error("Twitch session is not authorized.");
    const required = role === "broadcaster" ? BROADCASTER_SCOPES : CHAT_READER_SCOPES;
    if (!required.every((scope) => validation.scopes.includes(scope))) throw new Error("Twitch session is missing a required chat permission.");
    const identity = await api.getAuthorizedUser(tokens.accessToken);
    if (identity.id !== expectedId || identity.login.toLowerCase() !== credential.identity.login.toLowerCase()) throw new Error("Twitch session identity changed.");
    if (tokens.scopes.join(" ") !== validation.scopes.join(" ")) {
      tokens = { ...tokens, scopes: validation.scopes, expiresAt: Date.now() + validation.expiresIn * 1_000 };
      await persistCredential(role, identity, tokens);
    }
    return identity;
  } catch (error) {
    if (error instanceof TwitchApiError && error.status === 401) {
      try {
        tokens = await refreshTokens(api, tokens);
        const validation = await api.validateAccessToken(tokens.accessToken);
        if (validation.clientId !== requiredEnv("TWITCH_CLIENT_ID") || validation.userId !== expectedId) throw new Error("Twitch session is not authorized.");
        const identity = await api.getAuthorizedUser(tokens.accessToken);
        if (identity.id !== expectedId) throw new Error("Twitch session is not authorized.");
        tokens = { ...tokens, scopes: validation.scopes, expiresAt: Date.now() + validation.expiresIn * 1_000 };
        await persistCredential(role, identity, tokens);
        return identity;
      } catch {
        throw new Error("Twitch authorization expired or was revoked. Reconnect the account.");
      }
    }
    throw error;
  }
}

export async function disconnectTwitch(broadcasterId: string): Promise<boolean> {
  const [credential, botCredential] = await Promise.all([getCredential("broadcaster"), getCredential("chatReader")]);
  let revoked = true;
  if (credential?.identity.id === broadcasterId) {
    try {
      const tokens = decryptTokens(credential.encryptedTokens);
      await twitchApi("broadcaster").revokeAccessToken(tokens.accessToken);
    } catch {
      revoked = false;
    }
  }
  try {
    await deleteChatSubscription(credential?.identity.id, botCredential?.identity.id);
  } catch {
    revoked = false;
  }
  if (botCredential) {
    try {
      const tokens = decryptTokens(botCredential.encryptedTokens);
      await twitchApi("chatReader").revokeAccessToken(tokens.accessToken);
    } catch {
      revoked = false;
    }
  }
  await clearCredential("broadcaster", "broadcaster");
  await clearCredential("chatReader", "chatReader");
  await setTwitchStatus({ connection: "stopped", subscription: "none", error: null });
  return revoked;
}

export async function ensureChatSubscription(): Promise<void> {
  const [broadcaster, chatReader] = await Promise.all([
    getCredential("broadcaster"),
    getCredential("chatReader"),
  ]);
  if (!broadcaster || !chatReader) {
    await setTwitchStatus({ connection: "connecting", subscription: "pending", error: null });
    return;
  }
  if (broadcaster.identity.id === chatReader.identity.id) {
    await setTwitchStatus({ connection: "error", subscription: "error", error: "Use a separate Twitch account as the chat reader." });
    return;
  }
  if (!broadcaster.scopes.includes("channel:bot") || !chatReader.scopes.includes("user:read:chat") || !chatReader.scopes.includes("user:bot")) {
    await setTwitchStatus({ connection: "error", subscription: "error", error: "Reconnect Twitch and grant the broadcaster and chat-reader permissions." });
    return;
  }
  const callback = process.env.CONVEX_SITE_URL ? new URL("/twitch/eventsub", process.env.CONVEX_SITE_URL).toString() : "";
  const eventSubSecret = requiredEnv("TWITCH_EVENTSUB_SECRET");
  if (!callback.startsWith("https://") || eventSubSecret.length < 10 || eventSubSecret.length > 100) throw new Error("Twitch EventSub webhook configuration is incomplete.");
  try {
    const appToken = await getAppAccessToken();
    const existing = await listChatSubscriptions(appToken);
    const matching = existing.find((subscription) => subscription.condition?.broadcaster_user_id === broadcaster.identity.id &&
      subscription.condition?.user_id === chatReader.identity.id && subscription.transport?.callback === callback && subscription.status === "enabled");
    if (matching) {
      await setTwitchStatus({ connection: "connected", subscription: "enabled", error: null });
      return;
    }
    const response = await fetch("https://api.twitch.tv/helix/eventsub/subscriptions", {
      method: "POST",
      headers: { authorization: `Bearer ${appToken}`, "client-id": requiredEnv("TWITCH_CLIENT_ID"), "content-type": "application/json" },
      body: JSON.stringify({
        type: "channel.chat.message",
        version: "1",
        condition: { broadcaster_user_id: broadcaster.identity.id, user_id: chatReader.identity.id },
        transport: { method: "webhook", callback, secret: eventSubSecret },
      }),
      signal: AbortSignal.timeout(8_000),
    });
    if (!response.ok && response.status !== 409) throw new Error("Twitch rejected the EventSub subscription.");
    if (response.status === 409) {
      const refreshed = await listChatSubscriptions(appToken);
      const pendingOrEnabled = refreshed.find((subscription) => subscription.condition?.broadcaster_user_id === broadcaster.identity.id &&
        subscription.condition?.user_id === chatReader.identity.id && subscription.transport?.callback === callback &&
        ["webhook_callback_verification_pending", "enabled"].includes(subscription.status ?? ""));
      if (!pendingOrEnabled) throw new Error("Twitch reports a conflicting EventSub subscription.");
      if (pendingOrEnabled.status === "enabled") {
        await setTwitchStatus({ connection: "connected", subscription: "enabled", error: null });
        return;
      }
    }
    await setTwitchStatus({ connection: "connecting", subscription: "pending", error: "Waiting for Twitch to verify the webhook." });
  } catch {
    await setTwitchStatus({ connection: "error", subscription: "error", error: "Could not create the Twitch chat subscription. Check the authorization and webhook settings." });
    throw new Error("Twitch chat subscription could not be created.");
  }
}

function twitchApi(role: "broadcaster" | "chatReader"): TwitchApi {
  const redirect = role === "broadcaster" ? requiredEnv("TWITCH_REDIRECT_URI") : requiredEnv("TWITCH_BOT_REDIRECT_URI");
  return new TwitchApi({ clientId: requiredEnv("TWITCH_CLIENT_ID"), clientSecret: requiredEnv("TWITCH_CLIENT_SECRET"), redirectUri: new URL(redirect) });
}

async function getAppAccessToken(): Promise<string> {
  const body = new URLSearchParams({ client_id: requiredEnv("TWITCH_CLIENT_ID"), client_secret: requiredEnv("TWITCH_CLIENT_SECRET"), grant_type: "client_credentials" });
  const response = await fetch("https://id.twitch.tv/oauth2/token", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body, signal: AbortSignal.timeout(8_000) });
  if (!response.ok) throw new Error("Twitch application token request failed.");
  const value = await response.json() as Record<string, unknown>;
  if (typeof value.access_token !== "string") throw new Error("Twitch application token response was invalid.");
  return value.access_token;
}

interface EventSubSubscription { id?: string; status?: string; condition?: Record<string, string>; transport?: Record<string, string> }
async function listChatSubscriptions(appToken: string): Promise<EventSubSubscription[]> {
  const url = new URL("https://api.twitch.tv/helix/eventsub/subscriptions");
  url.searchParams.set("type", "channel.chat.message");
  const response = await fetch(url, { headers: { authorization: `Bearer ${appToken}`, "client-id": requiredEnv("TWITCH_CLIENT_ID") }, signal: AbortSignal.timeout(8_000) });
  if (!response.ok) throw new Error("Twitch subscription lookup failed.");
  const value = await response.json() as Record<string, unknown>;
  return Array.isArray(value.data) ? value.data.filter(isSubscription) : [];
}

async function deleteChatSubscription(broadcasterId?: string, chatReaderId?: string): Promise<void> {
  if (!broadcasterId || !chatReaderId) return;
  const appToken = await getAppAccessToken();
  const subscriptions = await listChatSubscriptions(appToken);
  const matching = subscriptions.filter((subscription) => subscription.condition?.broadcaster_user_id === broadcasterId && subscription.condition?.user_id === chatReaderId);
  for (const subscription of matching) {
    if (!subscription.id) continue;
    const url = new URL("https://api.twitch.tv/helix/eventsub/subscriptions");
    url.searchParams.set("id", subscription.id);
    const response = await fetch(url, { method: "DELETE", headers: { authorization: `Bearer ${appToken}`, "client-id": requiredEnv("TWITCH_CLIENT_ID") }, signal: AbortSignal.timeout(8_000) });
    if (!response.ok && response.status !== 404) throw new Error("Twitch rejected EventSub subscription deletion.");
  }
}

async function refreshIfNeeded(api: TwitchApi, tokens: StoredTokens): Promise<StoredTokens> {
  if (tokens.expiresAt > Date.now() + 60_000) return tokens;
  return await refreshTokens(api, tokens);
}

async function refreshTokens(api: TwitchApi, tokens: StoredTokens): Promise<StoredTokens> {
  try {
    const response = await api.refreshToken(tokens.refreshToken);
    const rotated = {
      ...tokens,
      accessToken: response.accessToken,
      refreshToken: response.refreshToken ?? tokens.refreshToken,
      expiresAt: Date.now() + response.expiresIn * 1_000,
    };
    await persistCredential(tokens.role, tokens.identity, rotated);
    return rotated;
  } catch {
    throw new Error("Twitch authorization expired or was revoked. Reconnect the account.");
  }
}

async function persistCredential(role: "broadcaster" | "chatReader", identity: DeployedIdentity, tokens: StoredTokens): Promise<void> {
  await storeCredential({ key: role === "broadcaster" ? "broadcaster" : "chatReader", role, identity, encryptedTokens: encryptTokens(tokens), scopes: tokens.scopes });
}

interface EncryptedTokenEnvelope { version: 1; iv: string; tag: string; ciphertext: string }
function encryptTokens(tokens: StoredTokens): string {
  const key = encryptionKey();
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(tokens), "utf8"), cipher.final()]);
  const envelope: EncryptedTokenEnvelope = { version: 1, iv: iv.toString("base64"), tag: cipher.getAuthTag().toString("base64"), ciphertext: ciphertext.toString("base64") };
  return JSON.stringify(envelope);
}

function decryptTokens(value: string): StoredTokens {
  const envelope = JSON.parse(value) as Partial<EncryptedTokenEnvelope>;
  if (envelope.version !== 1 || typeof envelope.iv !== "string" || typeof envelope.tag !== "string" || typeof envelope.ciphertext !== "string") throw new Error("Encrypted Twitch credentials are invalid.");
  const decipher = createDecipheriv("aes-256-gcm", encryptionKey(), Buffer.from(envelope.iv, "base64"));
  decipher.setAuthTag(Buffer.from(envelope.tag, "base64"));
  const raw = Buffer.concat([decipher.update(Buffer.from(envelope.ciphertext, "base64")), decipher.final()]).toString("utf8");
  const tokens = JSON.parse(raw) as Partial<StoredTokens>;
  if (typeof tokens.accessToken !== "string" || typeof tokens.refreshToken !== "string" || !Number.isSafeInteger(tokens.expiresAt) || !Array.isArray(tokens.scopes) || !tokens.identity || !["broadcaster", "chatReader"].includes(tokens.role ?? "")) throw new Error("Encrypted Twitch credentials are invalid.");
  return tokens as StoredTokens;
}

function encryptionKey(): Buffer {
  const text = requiredEnv("TOKEN_ENCRYPTION_KEY");
  const key = Buffer.from(text, "base64");
  if (key.length !== 32 || key.toString("base64") !== text) throw new Error("TOKEN_ENCRYPTION_KEY must be a base64-encoded 32-byte key.");
  return key;
}

function requiredEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is not configured.`);
  return value;
}

function isSubscription(value: unknown): value is EventSubSubscription {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
