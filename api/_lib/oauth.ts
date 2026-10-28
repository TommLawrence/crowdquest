import type { ServerResponse } from "node:http";
import type { ApiRequest } from "./http.js";
import { json, methodNotAllowed, redirect, requestUrl } from "./http.js";
import { beginOAuth, clearOAuthState, readStreamerSession, setStreamerSession, verifyOAuth } from "../../server/deployed-session.js";
import { completeTwitchAuthorization, ensureChatSubscription, validateStoredCredential } from "../../server/deployed-twitch.js";
import { clearCredential, setTwitchStatus } from "../../server/convex-service.js";

const READ_CHAT_SCOPES = "user:read:chat user:bot";

export async function startOAuth(request: ApiRequest, response: ServerResponse, role: "broadcaster" | "chatReader"): Promise<void> {
  if (request.method !== "GET") return methodNotAllowed(response, "GET");
  const clientId = process.env.TWITCH_CLIENT_ID?.trim();
  const redirectUri = role === "broadcaster" ? process.env.TWITCH_REDIRECT_URI?.trim() : process.env.TWITCH_BOT_REDIRECT_URI?.trim();
  if (!clientId || !redirectUri || !process.env.SESSION_SECRET || !process.env.TWITCH_CLIENT_SECRET) {
    return json(response, 503, { error: "Twitch OAuth is not configured." });
  }
  let streamerId: string | null = null;
  if (role === "chatReader") {
    const session = readStreamerSession(request);
    if (!session) return json(response, 401, { error: "Connect the broadcaster before connecting the chat reader." });
    try { await validateStoredCredential("broadcaster", session.id); }
    catch { return json(response, 401, { error: "Reconnect the broadcaster before connecting the chat reader." }); }
    streamerId = session.id;
  }
  try {
    const nonce = beginOAuth(role, streamerId, response);
    const authorization = new URL("https://id.twitch.tv/oauth2/authorize");
    authorization.search = new URLSearchParams({
      client_id: clientId,
      redirect_uri: new URL(redirectUri).toString(),
      response_type: "code",
      scope: role === "broadcaster" ? "channel:bot" : READ_CHAT_SCOPES,
      state: nonce,
      force_verify: "true",
    }).toString();
    response.writeHead(302, { location: authorization.toString(), "cache-control": "no-store", "referrer-policy": "no-referrer" });
    response.end();
  } catch {
    json(response, 503, { error: "Twitch OAuth configuration is invalid." });
  }
}

export async function finishOAuth(request: ApiRequest, response: ServerResponse, role: "broadcaster" | "chatReader"): Promise<void> {
  if (request.method !== "GET") return methodNotAllowed(response, "GET");
  const url = requestUrl(request);
  const session = role === "chatReader" ? readStreamerSession(request) : null;
  const state = url.searchParams.get("state") ?? "";
  const validState = verifyOAuth(request, state, role, role === "chatReader" ? session?.id ?? null : null);
  clearOAuthState(response, role);
  if (!validState || (role === "chatReader" && !session)) {
    return redirect(response, "/?twitch=state-error");
  }
  if (url.searchParams.has("error")) {
    await safeSetStatus("error", "error", "Twitch authorization was cancelled.");
    return redirect(response, "/?twitch=cancelled");
  }
  const code = url.searchParams.get("code");
  if (!code || code.length > 2_048) return redirect(response, "/?twitch=callback-error");
  try {
    const identity = await completeTwitchAuthorization(code, role);
    if (role === "broadcaster") setStreamerSession(response, identity);
    else if (identity.id === session?.id) {
      await safeClearChatReaderIdentityMismatch(identity.id);
      return redirect(response, "/?twitch=role-error");
    }
    await ensureChatSubscription();
    return redirect(response, "/");
  } catch {
    await safeSetStatus("error", "error", "Twitch authorization or chat subscription failed. Check the status and reconnect.");
    return redirect(response, "/?twitch=connection-error");
  }
}

async function safeSetStatus(connection: "error", subscription: "error", error: string): Promise<void> {
  try { await setTwitchStatus({ connection, subscription, error }); }
  catch (cause) {
    console.warn("Could not update the connection status after OAuth failed.", cause instanceof Error ? cause.name : "UnknownError");
  }
}

async function safeClearChatReaderIdentityMismatch(identityId: string): Promise<void> {
  try {
    await clearCredential("chatReader", "chatReader");
  } catch {
    console.warn("Could not clear a chat-reader identity that conflicts with the broadcaster account.", identityId.length);
  }
}
