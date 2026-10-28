import type { ServerResponse } from "node:http";
import type { ApiRequest } from "../_lib/http.js";
import { json, methodNotAllowed } from "../_lib/http.js";
import { clearStreamerSession, readStreamerSession, sameOrigin } from "../../server/deployed-session.js";
import { disconnectTwitch, validateStoredCredential } from "../../server/deployed-twitch.js";

export default async function handler(request: ApiRequest, response: ServerResponse): Promise<void> {
  if (request.method !== "POST") return methodNotAllowed(response, "POST");
  if (!sameOrigin(request)) return json(response, 403, { error: "Request origin is not allowed." });
  const session = readStreamerSession(request);
  if (!session) return json(response, 401, { error: "A Twitch streamer session is required." });
  try { await validateStoredCredential("broadcaster", session.id); }
  catch { return json(response, 401, { error: "The Twitch session is no longer authorized." }); }
  try {
    const result = await disconnectTwitch(session.id);
    clearStreamerSession(response);
    json(response, 200, { disconnected: true, tokenRevoked: result, message: result ? "Twitch disconnected." : "Twitch was disconnected locally, but token revocation could not be confirmed." });
  } catch {
    json(response, 503, { error: "Twitch could not be disconnected. Retry after checking the server status." });
  }
}
