import type { ServerResponse } from "node:http";
import type { ApiRequest } from "../_lib/http.js";
import { json, methodNotAllowed } from "../_lib/http.js";
import { readStreamerSession } from "../../server/deployed-session.js";
import { getPublicStatus, getTwitchIdentities } from "../../server/convex-service.js";

export default async function handler(request: ApiRequest, response: ServerResponse): Promise<void> {
  if (request.method !== "GET") return methodNotAllowed(response, "GET");
  try {
    const status = await getPublicStatus();
    const identities = await getTwitchIdentities();
    const session = readStreamerSession(request);
    const authenticatedSession = Boolean(session && status.authorized && identities.broadcaster?.id === session.id);
    json(response, 200, {
      ...status,
      configured: Boolean(
        process.env.TWITCH_CLIENT_ID?.trim() && process.env.TWITCH_CLIENT_SECRET?.trim() &&
        process.env.TWITCH_REDIRECT_URI?.trim() && process.env.TWITCH_BOT_REDIRECT_URI?.trim() &&
        process.env.SESSION_SECRET?.trim() && process.env.TOKEN_ENCRYPTION_KEY?.trim() &&
        process.env.CONVEX_URL?.trim() && process.env.CONVEX_SITE_URL?.trim() &&
        process.env.CONVEX_SERVICE_SECRET?.trim() && process.env.TWITCH_EVENTSUB_SECRET?.trim()
      ),
      authenticatedSession,
      sessionMode: authenticatedSession ? "twitch" : null,
      broadcaster: status.broadcaster,
      latestCommand: null,
      error: status.eventSub.error,
    });
  } catch {
    json(response, 503, {
      configured: false, authorized: false, authenticatedSession: false, sessionMode: null, broadcaster: null, chatReader: null,
      eventSub: { connection: "error", subscription: "none", reconnectAttempts: 0, error: "Application status is temporarily unavailable." },
      messagesReceived: 0, lastMessageAt: null, latestCommand: null, error: "Application status is temporarily unavailable.",
    });
  }
}
