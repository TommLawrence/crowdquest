import { createServer, type Server } from "node:http";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadConfig } from "./config.js";
import { createHttpHandler } from "./http-app.js";
import { createInitialState, type ChallengeState } from "../src/domain/challenge.js";
import { TwitchIntegration } from "./twitch-integration.js";
import { ChallengeRuntime } from "./challenge-runtime.js";
import { createPublicAppState } from "./app-state.js";

class AutoWelcomeSocket {
  private readonly listeners = new Map<string, ((event: { data?: unknown; code?: number }) => void)[]>();
  closed = false;

  constructor() {
    queueMicrotask(() => this.emit("message", {
      data: JSON.stringify({
        metadata: { message_id: "test-welcome", message_type: "session_welcome" },
        payload: { session: { id: "test-session", keepalive_timeout_seconds: 30, reconnect_url: null } },
      }),
    }));
  }

  addEventListener(type: string, listener: (event: { data?: unknown; code?: number }) => void): void {
    const values = this.listeners.get(type) ?? [];
    values.push(listener);
    this.listeners.set(type, values);
  }

  close(code = 1000): void {
    if (this.closed) return;
    this.closed = true;
    this.emit("close", { code });
  }

  private emit(type: string, event: { data?: unknown; code?: number }): void {
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }
}

const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
  const url = String(input);
  if (url.startsWith("http://127.0.0.1:")) return nativeFetch(input, init);
  if (url.endsWith("/oauth2/token")) {
    return Response.json({
      access_token: "mock-access-token",
      refresh_token: "mock-refresh-token",
      expires_in: 3_600,
      scope: ["user:read:chat"],
      token_type: "bearer",
    });
  }
  if (url.endsWith("/oauth2/validate")) {
    return Response.json({
      client_id: "test-client-id",
      user_id: "broadcaster-123",
      login: "teststreamer",
      scopes: ["user:read:chat"],
      expires_in: 3_600,
    });
  }
  if (url.endsWith("/helix/users")) {
    return Response.json({ data: [{ id: "broadcaster-123", login: "teststreamer", display_name: "TestStreamer" }] });
  }
  if (url.endsWith("/eventsub/subscriptions")) {
    const request = JSON.parse(String(init?.body)) as { condition: Record<string, string>; type: string; version: string; transport: Record<string, string> };
    expect(request).toMatchObject({
      type: "channel.chat.message",
      version: "1",
      condition: { broadcaster_user_id: "broadcaster-123", user_id: "broadcaster-123" },
      transport: { method: "websocket", session_id: "test-session" },
    });
    return Response.json({ data: [{ id: "subscription-id", type: "channel.chat.message", version: "1", status: "enabled" }] });
  }
  if (url.endsWith("/oauth2/revoke")) return new Response(null, { status: 200 });
  throw new Error("Unexpected mocked Twitch request.");
});
const nativeFetch = globalThis.fetch.bind(globalThis);
const dataDirectories: string[] = [];

afterEach(async () => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  await Promise.all(dataDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("Twitch HTTP routes", () => {
  it("keeps status and connect endpoints safe when required configuration is missing", async () => {
    const config = loadConfig({ PORT: "3000" });
    const integration = makeIntegration(config);
    await withServer(config, integration, async (baseUrl) => {
      const statusResponse = await fetch(`${baseUrl}/api/twitch/status`);
      const status = await statusResponse.json() as Record<string, unknown>;
      expect(statusResponse.status).toBe(200);
      expect(status.configured).toBe(false);
      expect(status.authorized).toBe(false);
      expect(status).not.toHaveProperty("accessToken");
      expect(status).not.toHaveProperty("refreshToken");

      const connectResponse = await fetch(`${baseUrl}/auth/twitch/connect`, { redirect: "manual" });
      expect(connectResponse.status).toBe(503);
      expect(await connectResponse.json()).toMatchObject({ error: expect.stringContaining("TWITCH_CLIENT_ID") });
    });
  });

  it("starts OAuth with the exact callback and only read-chat scope", async () => {
    const config = loadConfig(testEnv());
    const integration = makeIntegration(config);
    await withServer(config, integration, async (baseUrl) => {
      const response = await fetch(`${baseUrl}/auth/twitch/connect`, { redirect: "manual" });
      const location = new URL(response.headers.get("location") ?? "");
      const stateCookie = response.headers.getSetCookie()[0] ?? "";
      expect(response.status).toBe(302);
      expect(location.origin).toBe("https://id.twitch.tv");
      expect(location.searchParams.get("scope")).toBe("user:read:chat");
      expect(location.searchParams.get("redirect_uri")).toBe("http://localhost:3000/auth/twitch/callback");
      expect(location.searchParams.get("state")).toHaveLength(43);
      expect(stateCookie).toContain("HttpOnly");
      expect(stateCookie).toContain("SameSite=Lax");
      expect(stateCookie).toContain("Path=/auth/twitch/callback");
      expect(stateCookie).not.toContain("Secure");
      expect(location.toString()).not.toContain("user:write:chat");
    });
  });

  it("consumes a valid denial state without exchanging an authorization code", async () => {
    const config = loadConfig(testEnv());
    const integration = makeIntegration(config);
    await withServer(config, integration, async (baseUrl) => {
      const connect = await fetch(`${baseUrl}/auth/twitch/connect`, { redirect: "manual" });
      const stateCookie = (connect.headers.getSetCookie()[0] ?? "").split(";", 1)[0] ?? "";
      const state = new URL(connect.headers.get("location") ?? "").searchParams.get("state") ?? "";
      const denialUrl = new URL("/auth/twitch/callback", baseUrl);
      denialUrl.searchParams.set("error", "access_denied");
      denialUrl.searchParams.set("state", state);
      const response = await fetch(denialUrl, { headers: { cookie: stateCookie }, redirect: "manual" });

      expect(response.status).toBe(303);
      expect(response.headers.get("location")).toBe("/");
      expect(integration.status(null).error).toContain("authorization was cancelled");
    });
  });

  it("completes a mocked OAuth callback, sets a signed session, exposes sanitized status, and revokes on disconnect", async () => {
    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal("WebSocket", AutoWelcomeSocket);
    const config = loadConfig(testEnv());
    const runtime = new ChallengeRuntime();
    const integration = new TwitchIntegration(config, () => runtime.state, () => {}, () => {}, runtime.chat);

    await withServer(config, integration, async (baseUrl) => {
      const connect = await fetch(`${baseUrl}/auth/twitch/connect`, { redirect: "manual" });
      const stateCookieHeader = connect.headers.getSetCookie()[0] ?? "";
      const stateCookie = stateCookieHeader.split(";", 1)[0] ?? "";
      const state = new URL(connect.headers.get("location") ?? "").searchParams.get("state");
      expect(state).toBeTruthy();

      const callbackUrl = new URL("/auth/twitch/callback", baseUrl);
      callbackUrl.searchParams.set("code", "mock-authorization-code");
      callbackUrl.searchParams.set("state", state ?? "");
      const callback = await fetch(callbackUrl, {
        headers: { cookie: stateCookie },
        redirect: "manual",
      });
      expect(callback.status).toBe(303);
      expect(callback.headers.get("location")).toBe("/");
      const callbackCookies = callback.headers.getSetCookie();
      const sessionCookie = callbackCookies.find((cookie) => cookie.startsWith("cq_session=")) ?? "";
      expect(sessionCookie).toContain("HttpOnly");
      expect(sessionCookie).toContain("SameSite=Lax");
      expect(sessionCookie).not.toContain("mock-access-token");

      await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledWith(
        "https://api.twitch.tv/helix/eventsub/subscriptions",
        expect.anything(),
      ));
      await vi.waitFor(() => expect(integration.status(null).eventSub.subscription).toBe("enabled"));

      const cookiePair = sessionCookie.split(";", 1)[0] ?? "";
      const statusResponse = await fetch(`${baseUrl}/api/twitch/status`, { headers: { cookie: cookiePair } });
      const status = await statusResponse.json() as Record<string, unknown>;
      expect(status).toMatchObject({
        configured: true,
        authorized: true,
        authenticatedSession: true,
        broadcaster: { login: "teststreamer", displayName: "TestStreamer" },
      });
      expect(JSON.stringify(status)).not.toContain("mock-access-token");
      expect(JSON.stringify(status)).not.toContain("mock-refresh-token");
      expect(JSON.stringify(status)).not.toContain("test-client-secret");

      const simulationSession = await fetch(`${baseUrl}/api/simulation/session`, {
        method: "POST",
        headers: { origin: "http://localhost:3000", "content-type": "application/json" },
        body: "{}",
      });
      expect(simulationSession.status).toBe(200);
      expect(simulationSession.headers.getSetCookie().some((cookie) => cookie.startsWith("cq_sim_session="))).toBe(true);
      const stillAuthenticated = await fetch(`${baseUrl}/api/twitch/status`, { headers: { cookie: cookiePair } });
      expect(await stillAuthenticated.json()).toMatchObject({ authenticatedSession: true, broadcaster: { login: "teststreamer" } });

      const liveAction = await fetch(`${baseUrl}/api/challenge/action`, {
        method: "POST",
        headers: { cookie: cookiePair, origin: "http://localhost:3000", "content-type": "application/json" },
        body: JSON.stringify({
          type: "start-round",
          config: { suggestionDurationMs: 5_000, votingDurationMs: 5_000, challengeDurationMs: 60_000, chargeGoal: 25, chargePerMessage: 1 },
        }),
      });
      expect(liveAction.status).toBe(200);
      expect(runtime.state.phase).toBe("suggestions");
      expect(runtime.source).toBe("live");

      const invalidTransition = await fetch(`${baseUrl}/api/challenge/action`, {
        method: "POST",
        headers: { cookie: cookiePair, origin: "http://localhost:3000", "content-type": "application/json" },
        body: JSON.stringify({ type: "approve-candidates", suggestionIds: ["not-submitted"] }),
      });
      expect(invalidTransition.status).toBe(409);

      const crossOriginDisconnect = await fetch(`${baseUrl}/api/twitch/disconnect`, {
        method: "POST",
        headers: { cookie: cookiePair, origin: "https://attacker.example" },
      });
      expect(crossOriginDisconnect.status).toBe(403);

      const replay = await fetch(callbackUrl, { headers: { cookie: stateCookie }, redirect: "manual" });
      expect(replay.status).toBe(400);

      const disconnect = await fetch(`${baseUrl}/api/twitch/disconnect`, {
        method: "POST",
        headers: { cookie: cookiePair, origin: "http://localhost:3000" },
      });
      expect(disconnect.status).toBe(200);
      expect(await disconnect.json()).toMatchObject({ disconnected: true, tokenRevoked: true });
      expect(fetchMock.mock.calls.some(([url]) => String(url).endsWith("/oauth2/revoke"))).toBe(true);
    }, runtime);
  });

  it("rejects disconnect without a validated server session", async () => {
    const config = loadConfig(testEnv());
    const integration = makeIntegration(config);
    await withServer(config, integration, async (baseUrl) => {
      const response = await fetch(`${baseUrl}/api/twitch/disconnect`, {
        method: "POST",
        headers: { origin: "http://localhost:3000" },
      });
      expect(response.status).toBe(401);
    });
  });

  it("runs a full labelled simulation round through the same challenge engine", async () => {
    const config = loadConfig({ PORT: "3000", SIMULATED_CHAT_ENABLED: "true" });
    const runtime = new ChallengeRuntime();
    const integration = new TwitchIntegration(config, () => runtime.state, () => {}, () => {}, runtime.chat);

    await withServer(config, integration, async (baseUrl) => {
      const origin = "http://localhost:3000";
      const unauthenticated = await fetch(`${baseUrl}/api/challenge/action`, {
        method: "POST", headers: { origin, "content-type": "application/json" },
        body: JSON.stringify({ type: "start-round", config: { chargeGoal: 1 } }),
      });
      expect(unauthenticated.status).toBe(401);

      const sessionResponse = await fetch(`${baseUrl}/api/simulation/session`, {
        method: "POST", headers: { origin, "content-type": "application/json" }, body: "{}",
      });
      expect(sessionResponse.status).toBe(200);
      expect(await sessionResponse.json()).toMatchObject({ started: true, label: expect.stringContaining("DEMO") });
      const cookie = (sessionResponse.headers.getSetCookie().find((value) => value.startsWith("cq_sim_session=")) ?? "").split(";", 1)[0] ?? "";

      const crossOrigin = await fetch(`${baseUrl}/api/simulation/action`, {
        method: "POST", headers: { cookie, origin: "https://attacker.example", "content-type": "application/json" },
        body: JSON.stringify({ type: "start-round", config: {} }),
      });
      expect(crossOrigin.status).toBe(403);

      const configBody = {
        suggestionDurationMs: 5_000,
        votingDurationMs: 5_000,
        challengeDurationMs: 20_000,
        chargeGoal: 2,
        chargePerMessage: 1,
      };
      const start = await fetch(`${baseUrl}/api/simulation/action`, {
        method: "POST", headers: { cookie, origin, "content-type": "application/json" },
        body: JSON.stringify({ type: "start-round", config: configBody, streamerId: "attacker" }),
      });
      expect(start.status).toBe(400);

      const started = await fetch(`${baseUrl}/api/simulation/action`, {
        method: "POST", headers: { cookie, origin, "content-type": "application/json" },
        body: JSON.stringify({ type: "start-round", config: configBody }),
      });
      expect(started.status).toBe(200);
      expect(runtime.state.phase).toBe("suggestions");

      const send = async (text: string, viewerSlot: number) => fetch(`${baseUrl}/api/simulation/message`, {
        method: "POST", headers: { cookie, origin, "content-type": "application/json" },
        body: JSON.stringify({ text, viewerSlot }),
      });
      expect((await send("!suggest No jumping", 1)).status).toBe(202);
      expect((await send("!suggest Use a shield", 2)).status).toBe(202);
      expect(runtime.state.suggestions).toHaveLength(2);
      expect(runtime.chat.snapshot().activity.every((entry) => entry.source === "simulated")).toBe(true);

      runtime.advance((runtime.state.phaseEndsAt ?? Date.now()) + 1);
      const approval = await fetch(`${baseUrl}/api/simulation/action`, {
        method: "POST", headers: { cookie, origin, "content-type": "application/json" },
        body: JSON.stringify({ type: "approve-candidates", suggestionIds: runtime.state.suggestions.map((item) => item.id) }),
      });
      expect(approval.status).toBe(200);
      expect((await send("!vote A", 1)).status).toBe(202);
      expect((await send("!vote B", 2)).status).toBe(202);
      expect((await send("!vote A", 1)).status).toBe(202);
      expect(runtime.state.votes).toHaveProperty("user:simulated-viewer-1");
      expect(Object.keys(runtime.state.votes)).toHaveLength(2);

      runtime.advance((runtime.state.phaseEndsAt ?? Date.now()) + 1);
      expect(runtime.state.phase).toBe("active");
      expect(runtime.state.winningCandidateId).toBe(runtime.state.candidates[0]?.id);
      expect((await send("!charge", 1)).status).toBe(202);
      expect((await send("!charge", 2)).status).toBe(202);
      expect(runtime.state.phase).toBe("succeeded");

      const publicStateResponse = await fetch(`${baseUrl}/api/state`);
      const publicState = await publicStateResponse.json() as Record<string, unknown>;
      expect(publicState).toMatchObject({ challengeSource: "simulated", simulatedChatEnabled: true });
      expect(JSON.stringify(publicState)).toContain("simulated");
      expect(JSON.stringify(publicState)).not.toContain("user:simulated-viewer");
      expect(JSON.stringify(publicState)).not.toContain("accessToken");
    }, runtime);
  });

  it("keeps simulation unavailable unless the explicit flag is enabled", async () => {
    const config = loadConfig({ PORT: "3000" });
    const integration = makeIntegration(config);
    await withServer(config, integration, async (baseUrl) => {
      const response = await fetch(`${baseUrl}/api/simulation/session`, {
        method: "POST", headers: { origin: "http://localhost:3000", "content-type": "application/json" }, body: "{}",
      });
      expect(response.status).toBe(404);
    });
  });
});

function makeIntegration(config: ReturnType<typeof loadConfig>): TwitchIntegration {
  let state: ChallengeState = createInitialState();
  return new TwitchIntegration(config, () => state, (next) => { state = next; });
}

async function withServer(
  config: ReturnType<typeof loadConfig>,
  integration: TwitchIntegration,
  callback: (baseUrl: string) => Promise<void>,
  runtime?: ChallengeRuntime,
): Promise<void> {
  const handler = createHttpHandler(
    config,
    integration,
    runtime,
    runtime ? () => createPublicAppState(runtime, integration, config) : undefined,
  );
  const server: Server = createServer((request, response) => {
    void handler(request, response).then((handled) => {
      if (!handled) {
        response.writeHead(404);
        response.end();
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Test server failed to bind.");
  try {
    await callback(`http://127.0.0.1:${address.port}`);
  } finally {
    await integration.stop();
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
}

function testEnv(): NodeJS.ProcessEnv {
  const dataDirectory = join(tmpdir(), `crowdquest-http-${randomUUID()}`);
  dataDirectories.push(dataDirectory);
  return {
    TWITCH_CLIENT_ID: "test-client-id",
    TWITCH_CLIENT_SECRET: "test-client-secret",
    TWITCH_REDIRECT_URI: "http://localhost:3000/auth/twitch/callback",
    SESSION_SECRET: "s".repeat(40),
    TOKEN_ENCRYPTION_KEY: Buffer.alloc(32, 4).toString("base64"),
    DATA_DIR: dataDirectory,
    PORT: "3000",
    SIMULATED_CHAT_ENABLED: "true",
  };
}
