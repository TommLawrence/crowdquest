import type { ServerResponse } from "node:http";
import type { ApiRequest } from "../_lib/http.js";
import { json, methodNotAllowed, requestObject } from "../_lib/http.js";
import { describeTransitionError, parseStreamerAction } from "../../server/http-app.js";
import { readStreamerSession, sameOrigin } from "../../server/deployed-session.js";
import { invokeChallengeAction } from "../../server/convex-service.js";
import { validateStoredCredential } from "../../server/deployed-twitch.js";

export default async function handler(request: ApiRequest, response: ServerResponse): Promise<void> {
  if (request.method !== "POST") return methodNotAllowed(response, "POST");
  if (!sameOrigin(request)) return json(response, 403, { error: "Request origin is not allowed." });
  const session = readStreamerSession(request);
  if (!session) return json(response, 401, { error: "A Twitch streamer session is required." });
  const body = requestObject(request);
  const action = parseStreamerAction(body);
  if (!action) return json(response, 400, { error: "Invalid challenge action or configuration." });
  try {
    await validateStoredCredential("broadcaster", session.id);
  } catch {
    return json(response, 401, { error: "The Twitch session could not be validated. Reconnect before controlling the challenge." });
  }
  try {
    const result = await invokeChallengeAction(session.id, action);
    if (!result.accepted) {
      const error = result.error ?? "invalid-phase";
      return json(response, 409, { accepted: false, error, message: describeTransitionError(error) });
    }
    json(response, 200, { accepted: true, revision: result.revision });
  } catch {
    json(response, 503, { error: "The challenge service is temporarily unavailable." });
  }
}
