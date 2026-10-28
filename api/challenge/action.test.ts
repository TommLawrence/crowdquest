import { beforeEach, describe, expect, it, vi } from "vitest";

const validateStoredCredential = vi.hoisted(() => vi.fn());
const invokeChallengeAction = vi.hoisted(() => vi.fn());

vi.mock("../../server/deployed-twitch.js", () => ({ validateStoredCredential }));
vi.mock("../../server/convex-service.js", () => ({ invokeChallengeAction }));

import handler from "./action.js";
import { setStreamerSession } from "../../server/deployed-session.js";
import type { ServerResponse } from "node:http";

class FakeResponse {
  statusCode = 0;
  headers = new Map<string, string | string[]>();
  body = "";
  writeHead(status: number, headers: Record<string, string> = {}) {
    this.statusCode = status;
    for (const [key, value] of Object.entries(headers)) this.headers.set(key.toLowerCase(), value);
    return this;
  }
  end(body = "") { this.body = body; return this; }
  getHeader(name: string) { return this.headers.get(name.toLowerCase()); }
  setHeader(name: string, value: string | string[]) { this.headers.set(name.toLowerCase(), value); return this; }
}

function sessionCookie(): string {
  const response = new FakeResponse();
  setStreamerSession(response as unknown as ServerResponse, { id: "streamer-verified", login: "streamer", displayName: "Streamer" });
  const cookies = response.getHeader("set-cookie");
  const cookie = Array.isArray(cookies) ? cookies[0] : cookies;
  if (!cookie) throw new Error("Expected the server to issue a session cookie.");
  return cookie.split(";")[0] ?? "";
}

function request(overrides: Record<string, unknown> = {}) {
  return {
    method: "POST",
    url: "/api/challenge/action",
    headers: { origin: "https://crowdquest.example", cookie: sessionCookie() },
    body: { type: "start-round", config: { suggestionDurationMs: 5_000, votingDurationMs: 5_000, challengeDurationMs: 10_000, chargeGoal: 5, chargePerMessage: 1 } },
    ...overrides,
  };
}

describe("Vercel challenge action authorization", () => {
  beforeEach(() => vi.clearAllMocks());
  it("requires a same-origin request and signed streamer session", async () => {
    process.env.SESSION_SECRET = "s".repeat(40);
    process.env.TWITCH_REDIRECT_URI = "https://crowdquest.example/api/twitch/callback";
    const crossOrigin = new FakeResponse();
    await handler(request({ headers: { origin: "https://attacker.example", cookie: sessionCookie() } }) as never, crossOrigin as unknown as ServerResponse);
    expect(crossOrigin.statusCode).toBe(403);

    const noSession = new FakeResponse();
    await handler(request({ headers: { origin: "https://crowdquest.example" } }) as never, noSession as unknown as ServerResponse);
    expect(noSession.statusCode).toBe(401);
    expect(validateStoredCredential).not.toHaveBeenCalled();
  });

  it("derives the broadcaster identity from the validated server session", async () => {
    process.env.SESSION_SECRET = "s".repeat(40);
    process.env.TWITCH_REDIRECT_URI = "https://crowdquest.example/api/twitch/callback";
    validateStoredCredential.mockResolvedValue({ id: "streamer-verified", login: "streamer", displayName: "Streamer" });
    invokeChallengeAction.mockResolvedValue({ accepted: true, revision: 1 });
    const response = new FakeResponse();
    await handler(request() as never, response as unknown as ServerResponse);

    expect(response.statusCode).toBe(200);
    expect(validateStoredCredential).toHaveBeenCalledWith("broadcaster", "streamer-verified");
    expect(invokeChallengeAction).toHaveBeenCalledWith("streamer-verified", expect.objectContaining({ type: "start-round" }));
    expect(invokeChallengeAction).not.toHaveBeenCalledWith("attacker-id", expect.anything());
  });

  it("rejects client-provided identity or role fields", async () => {
    process.env.SESSION_SECRET = "s".repeat(40);
    process.env.TWITCH_REDIRECT_URI = "https://crowdquest.example/api/twitch/callback";
    const response = new FakeResponse();
    await handler(request({ body: { ...(request().body as object), broadcasterId: "attacker-id", role: "streamer" } }) as never, response as unknown as ServerResponse);

    expect(response.statusCode).toBe(400);
    expect(validateStoredCredential).not.toHaveBeenCalled();
    expect(invokeChallengeAction).not.toHaveBeenCalled();
  });
});
