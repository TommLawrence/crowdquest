import { httpRouter } from "convex/server";
import { httpAction } from "./_generated/server.js";
import { internal } from "./_generated/api.js";
import { parseChatCommand } from "../src/domain/challenge.js";
import { constantTimeTextEqual, verifyTwitchWebhook } from "./webhook_security.js";

const http = httpRouter();
const MAX_BODY_BYTES = 64_000;

http.route({
  path: "/twitch/eventsub",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    const secret = process.env.TWITCH_EVENTSUB_SECRET ?? "";
    if (secret.length < 10 || secret.length > 100) return json({ error: "EventSub webhook is not configured." }, 503);
    let rawBody: string;
    try {
      rawBody = await request.text();
    } catch {
      return json({ error: "Invalid webhook body." }, 400);
    }
    if (new TextEncoder().encode(rawBody).length > MAX_BODY_BYTES) return json({ error: "Webhook body is too large." }, 413);
    const messageId = request.headers.get("Twitch-Eventsub-Message-Id");
    const timestamp = request.headers.get("Twitch-Eventsub-Message-Timestamp");
    const signature = request.headers.get("Twitch-Eventsub-Message-Signature");
    if (!await verifyTwitchWebhook({ secret, messageId, timestamp, signature, rawBody })) return json({ error: "Invalid or expired EventSub signature." }, 403);

    let payload: unknown;
    try {
      payload = JSON.parse(rawBody) as unknown;
    } catch {
      return json({ error: "Invalid webhook JSON." }, 400);
    }
    if (!isRecord(payload) || !isRecord(payload.subscription)) return json({ error: "Invalid EventSub payload." }, 400);
    const messageType = request.headers.get("Twitch-Eventsub-Message-Type");
    const subscription = payload.subscription;
    if (subscription.type !== "channel.chat.message" || subscription.version !== "1" || !isRecord(subscription.condition)) {
      return json({ error: "Unexpected EventSub subscription." }, 400);
    }
    const broadcasterId = subscription.condition.broadcaster_user_id;
    const chatReaderId = subscription.condition.user_id;
    if (typeof broadcasterId !== "string" || typeof chatReaderId !== "string") return json({ error: "Invalid EventSub subscription identity." }, 400);
    const identities = await ctx.runQuery(internal.state.getTwitchIdentities, {});
    if (identities.broadcaster?.id !== broadcasterId || identities.chatReader?.id !== chatReaderId) {
      return json({ error: "EventSub subscription identity does not match the connected channel." }, 403);
    }

    if (messageType === "webhook_callback_verification") {
      if (typeof payload.challenge !== "string" || payload.challenge.length > 2_000) return json({ error: "Invalid verification challenge." }, 400);
      await ctx.runMutation(internal.state.setTwitchStatus, { connection: "connected", subscription: "enabled", error: null });
      return new Response(payload.challenge, {
        status: 200,
        headers: { "content-type": "text/plain; charset=utf-8", "content-length": String(new TextEncoder().encode(payload.challenge).length) },
      });
    }

    if (messageType === "revocation") {
      await ctx.runMutation(internal.state.setTwitchStatus, {
        connection: "error",
        subscription: "revoked",
        error: "Twitch revoked the chat subscription. Reconnect the channel and chat reader.",
      });
      return new Response(null, { status: 204 });
    }

    if (messageType !== "notification" || !isRecord(payload.event)) return json({ error: "Unsupported EventSub message." }, 400);
    const event = payload.event;
    if (event.broadcaster_user_id !== broadcasterId || event.chatter_user_id === undefined || event.message_id === undefined || !isRecord(event.message) || typeof event.message.text !== "string") {
      return json({ error: "Invalid chat message event." }, 400);
    }
    if (typeof messageId !== "string" || typeof event.message_id !== "string" || typeof event.chatter_user_id !== "string") return json({ error: "Missing event identifiers." }, 400);
    const parsed = parseChatCommand(event.message.text);
    if (parsed.kind === "ignore") return new Response(null, { status: 204 });
    const receivedAt = Date.parse(timestamp ?? "");
    if (!Number.isFinite(receivedAt)) return json({ error: "Invalid EventSub timestamp." }, 400);
    const result = await ctx.runMutation(internal.state.applyChatEvent, {
      eventId: messageId,
      chatMessageId: event.message_id,
      broadcasterId,
      chatReaderId,
      userId: event.chatter_user_id,
      displayName: typeof event.chatter_user_name === "string" ? event.chatter_user_name : typeof event.chatter_user_login === "string" ? event.chatter_user_login : "Viewer",
      text: event.message.text,
      at: receivedAt,
    });
    return new Response(null, { status: result.reason === "subscription-identity-mismatch" ? 403 : 204 });
  }),
});

http.route({
  pathPrefix: "/internal/",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    const expected = process.env.CONVEX_SERVICE_SECRET ?? "";
    const supplied = request.headers.get("Authorization") ?? "";
    if (expected.length < 32 || !constantTimeTextEqual(supplied, `Bearer ${expected}`)) return json({ error: "Unauthorized." }, 401);
    const path = new URL(request.url).pathname;
    const body = await readObject(request);
    if (!body) return json({ error: "Invalid request body." }, 400);
    try {
      if (path === "/internal/action" && isRecord(body.action) && typeof body.streamerId === "string") {
        return json(await ctx.runMutation(internal.state.applyAction, { streamerId: body.streamerId, action: body.action as never }), 200);
      }
      if (path === "/internal/credential/store" && isCredentialBody(body)) {
        await ctx.runMutation(internal.state.storeCredential, { ...body, updatedAt: Date.now() });
        return json({ stored: true }, 200);
      }
      if (path === "/internal/credential/get" && typeof body.key === "string") {
        return json(await ctx.runQuery(internal.state.getCredential, { key: body.key }), 200);
      }
      if (path === "/internal/credential/clear" && typeof body.key === "string" && (body.role === "broadcaster" || body.role === "chatReader")) {
        await ctx.runMutation(internal.state.clearCredential, { key: body.key, role: body.role });
        return json({ cleared: true }, 200);
      }
      if (path === "/internal/status" && isEventSubStatus(body)) {
        await ctx.runMutation(internal.state.setTwitchStatus, body);
        return json({ updated: true }, 200);
      }
      if (path === "/internal/identities") {
        return json(await ctx.runQuery(internal.state.getTwitchIdentities, {}), 200);
      }
      return json({ error: "Not found." }, 404);
    } catch {
      return json({ error: "The internal operation could not be completed." }, 500);
    }
  }),
});

export default http;

async function readObject(request: Request): Promise<Record<string, unknown> | null> {
  try {
    const text = await request.text();
    if (new TextEncoder().encode(text).length > MAX_BODY_BYTES) return null;
    const value = JSON.parse(text) as unknown;
    return isRecord(value) ? value : null;
  } catch {
    return null;
  }
}

function isCredentialBody(value: Record<string, unknown>): value is Record<string, unknown> & {
  key: string;
  role: "broadcaster" | "chatReader";
  identity: { id: string; login: string; displayName: string };
  encryptedTokens: string;
  scopes: string[];
} {
  return typeof value.key === "string" && (value.role === "broadcaster" || value.role === "chatReader") &&
    isRecord(value.identity) && typeof value.identity.id === "string" && typeof value.identity.login === "string" && typeof value.identity.displayName === "string" &&
    typeof value.encryptedTokens === "string" && Array.isArray(value.scopes) && value.scopes.every((scope) => typeof scope === "string");
}

function isEventSubStatus(value: Record<string, unknown>): value is Record<string, unknown> & {
  connection: "stopped" | "connecting" | "connected" | "error";
  subscription: "none" | "pending" | "enabled" | "revoked" | "error";
  error: string | null;
} {
  return ["stopped", "connecting", "connected", "error"].includes(String(value.connection)) &&
    ["none", "pending", "enabled", "revoked", "error"].includes(String(value.subscription)) &&
    (value.error === null || typeof value.error === "string");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function json(value: unknown, status: number): Response {
  return Response.json(value, { status, headers: { "cache-control": "no-store" } });
}
