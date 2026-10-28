import type { IncomingMessage, ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import type { ChallengeConfig, StreamerAction } from "../src/domain/challenge.js";
import type { ChallengeRuntime } from "./challenge-runtime.js";
import type { RuntimeConfig } from "./config.js";
import type { PublicAppState } from "./app-state.js";
import type { TwitchIntegration } from "./twitch-integration.js";

const SESSION_COOKIE = "cq_session";
const SIMULATION_COOKIE = "cq_sim_session";
const OAUTH_STATE_COOKIE = "cq_oauth_state";
const SCOPE = "user:read:chat";
const AUTH_START_LIMIT = 20;
const AUTH_START_WINDOW_MS = 10 * 60 * 1_000;
const AUTH_START_MAX_ADDRESSES = 2_000;
const MAX_JSON_BODY_BYTES = 8_192;

interface RateRecord {
  count: number;
  resetAt: number;
}

export function createHttpHandler(
  config: RuntimeConfig,
  integration: TwitchIntegration,
  runtime?: ChallengeRuntime,
  getPublicState: () => PublicAppState = () => ({
    challenge: {
      revision: 0, phase: "idle", config: null, phaseEndsAt: null, pausedFrom: null,
      pausedRemainingMs: null, suggestions: [], candidates: [], voteCounts: {},
      contributionCount: 0, charge: 0, winningCandidateId: null,
    },
    challengeSource: null, suggestionMetadata: {}, activity: [],
    chat: { messagesReceived: 0, simulatedMessagesReceived: 0, lastMessageAt: null, latestCommand: null },
    twitch: { configured: integration.isConfigured, connected: false, connection: "stopped", subscription: "none", reconnectAttempts: 0, error: null },
    simulatedChatEnabled: config.simulatedChatEnabled,
  }),
) {
  const authStartsByAddress = new Map<string, RateRecord>();

  return async function handleRequest(request: IncomingMessage, response: ServerResponse): Promise<boolean> {
    applySecurityHeaders(response, config);
    let url: URL;
    try {
      url = new URL(request.url ?? "/", "http://localhost");
    } catch {
      sendJson(response, 400, { error: "Invalid request URL." });
      return true;
    }

    try {
      if (request.method === "GET" && url.pathname === "/health") {
        sendJson(response, 200, { status: "ok" });
        return true;
      }
      if (request.method === "GET" && url.pathname === "/api/twitch/status") {
        const principal = integration.sessions?.resolveSession(readCookie(request, SESSION_COOKIE)) ?? null;
        sendJson(response, 200, integration.status(principal));
        return true;
      }
      if (request.method === "GET" && url.pathname === "/api/simulation/status") {
        const principal = integration.sessions?.resolveSession(readCookie(request, SIMULATION_COOKIE)) ?? null;
        const enabled = isSimulationAvailable(config, request);
        sendJson(response, 200, { enabled, active: enabled && principal?.mode === "simulation" });
        return true;
      }
      if (request.method === "GET" && url.pathname === "/api/state") {
        sendJson(response, 200, getPublicState());
        return true;
      }
      if (request.method === "GET" && url.pathname === "/auth/twitch/connect") {
        handleConnect(request, response, config, integration, authStartsByAddress);
        return true;
      }
      if (request.method === "GET" && url.pathname === integration.callbackPath && integration.callbackPath) {
        await handleCallback(url, request, response, integration, config);
        return true;
      }
      if (request.method === "POST" && url.pathname === "/api/twitch/disconnect") {
        await handleDisconnect(request, response, integration);
        return true;
      }
      if (request.method === "POST" && url.pathname === "/api/challenge/action") {
        await handleChallengeAction(request, response, config, integration, runtime, "twitch");
        return true;
      }
      if (request.method === "POST" && url.pathname === "/api/simulation/action") {
        await handleChallengeAction(request, response, config, integration, runtime, "simulation");
        return true;
      }
      if (request.method === "POST" && url.pathname === "/api/simulation/session") {
        handleSimulationSession(request, response, config, integration);
        return true;
      }
      if (request.method === "POST" && url.pathname === "/api/simulation/message") {
        await handleSimulationMessage(request, response, config, integration, runtime);
        return true;
      }
      return false;
    } catch (error) {
      console.error("HTTP handler failed.", error instanceof Error ? error.name : "UnknownError");
      if (!response.headersSent) sendJson(response, 500, { error: "The request could not be completed." });
      else response.end();
      return true;
    }
  };
}

async function handleChallengeAction(
  request: IncomingMessage,
  response: ServerResponse,
  config: RuntimeConfig,
  integration: TwitchIntegration,
  runtime: ChallengeRuntime | undefined,
  requiredMode: "twitch" | "simulation",
): Promise<void> {
  if (!runtime) {
    sendJson(response, 503, { error: "Challenge controls are unavailable." });
    return;
  }
  const sessionCookie = requiredMode === "simulation" ? SIMULATION_COOKIE : SESSION_COOKIE;
  const principal = integration.sessions?.resolveSession(readCookie(request, sessionCookie)) ?? null;
  if (!principal || principal.mode !== requiredMode || (requiredMode === "twitch" && !integration.status(principal).authenticatedSession)) {
    sendJson(response, 401, { error: requiredMode === "simulation" ? "Start a local demo session to use these controls." : "A validated Twitch streamer session is required." });
    return;
  }
  if (requiredMode === "simulation" ? !isLocalMutationOriginAllowed(request, config) || !isSimulationAvailable(config, request) : !isMutationOriginAllowed(request, integration)) {
    sendJson(response, 403, { error: "The request origin is not allowed." });
    return;
  }

  const body = await readJson(request, response);
  if (body === null) return;
  const action = parseStreamerAction(body);
  if (!action) {
    sendJson(response, 400, { error: "Invalid challenge action or configuration." });
    return;
  }
  const result = runtime.act({ streamerId: principal.id, mode: principal.mode }, action);
  const sourceLabel = requiredMode === "simulation" ? "DEMO" : "LIVE";
  if (!result.accepted) {
    sendJson(response, 409, { accepted: false, error: result.error, message: describeTransitionError(result.error), source: sourceLabel });
    return;
  }
  sendJson(response, 200, { accepted: true, revision: result.state.revision, source: sourceLabel });
}

function handleSimulationSession(
  request: IncomingMessage,
  response: ServerResponse,
  config: RuntimeConfig,
  integration: TwitchIntegration,
): void {
  if (!isSimulationAvailable(config, request) || !isLocalMutationOriginAllowed(request, config)) {
    sendJson(response, 404, { error: "Local demo controls are disabled or unavailable." });
    return;
  }
  const session = integration.sessions?.createSimulationSession();
  if (!session) {
    sendJson(response, 503, { error: "Simulation sessions are unavailable." });
    return;
  }
  appendCookie(response, buildCookie(SIMULATION_COOKIE, session.cookieValue, {
    httpOnly: true,
    secure: false,
    sameSite: "Lax",
    path: "/",
    maxAgeSeconds: 12 * 60 * 60,
  }));
  sendJson(response, 200, { started: true, label: "DEMO · Local operator" });
}

async function handleSimulationMessage(
  request: IncomingMessage,
  response: ServerResponse,
  config: RuntimeConfig,
  integration: TwitchIntegration,
  runtime: ChallengeRuntime | undefined,
): Promise<void> {
  if (!runtime || !isSimulationAvailable(config, request) || !isLocalMutationOriginAllowed(request, config)) {
    sendJson(response, 404, { error: "Local demo controls are disabled or unavailable." });
    return;
  }
  const principal = integration.sessions?.resolveSession(readCookie(request, SIMULATION_COOKIE)) ?? null;
  if (!principal || principal.mode !== "simulation") {
    sendJson(response, 401, { error: "Start a clearly labelled local simulation session first." });
    return;
  }
  const body = await readJson(request, response);
  if (body === null) return;
  if (!isRecord(body) || !hasOnlyKeys(body, ["text", "viewerSlot"]) || typeof body.text !== "string" || body.text.length > 500 ||
      !Number.isInteger(body.viewerSlot) || (body.viewerSlot as number) < 1 || (body.viewerSlot as number) > 5) {
    sendJson(response, 400, { error: "Provide a chat command and a demo viewer number from 1 to 5." });
    return;
  }
  const viewerSlot = body.viewerSlot as number;
  const now = Date.now();
  runtime.receive({
    notificationId: `simulated:${randomUUID()}`,
    messageId: `simulated:${randomUUID()}`,
    broadcasterId: "simulated-channel",
    userId: `simulated-viewer-${viewerSlot}`,
    login: `simulation_viewer_${viewerSlot}`,
    displayName: `Demo Viewer ${viewerSlot}`,
    text: body.text,
    timestamp: now,
  }, "simulated");
  sendJson(response, 202, { accepted: true, source: "DEMO" });
}

function isMutationOriginAllowed(request: IncomingMessage, integration: TwitchIntegration): boolean {
  return Boolean(integration.redirectOrigin && request.headers.origin === integration.redirectOrigin);
}

function isSimulationAvailable(config: RuntimeConfig, request: IncomingMessage): boolean {
  return config.simulatedChatEnabled && process.env.NODE_ENV !== "production" && isLocalAddress(request);
}

function isLocalMutationOriginAllowed(request: IncomingMessage, config: RuntimeConfig): boolean {
  if (!isLocalAddress(request)) return false;
  const origin = request.headers.origin;
  if (!origin) return false;
  const acceptedOrigins = new Set([
    `http://localhost:${config.port}`,
    `http://127.0.0.1:${config.port}`,
    `http://[::1]:${config.port}`,
  ]);
  return acceptedOrigins.has(origin);
}

function isLocalAddress(request: IncomingMessage): boolean {
  const address = request.socket.remoteAddress ?? "";
  return address === "127.0.0.1" || address === "::1" || address.startsWith("::ffff:127.");
}

async function readJson(request: IncomingMessage, response: ServerResponse): Promise<unknown | null> {
  const contentType = request.headers["content-type"]?.split(";", 1)[0]?.trim().toLowerCase();
  if (contentType !== "application/json") {
    sendJson(response, 415, { error: "Send a JSON request body." });
    return null;
  }
  try {
    const chunks: Buffer[] = [];
    let length = 0;
    for await (const chunk of request) {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      length += bytes.length;
      if (length > MAX_JSON_BODY_BYTES) {
        sendJson(response, 413, { error: "The request body is too large." });
        return null;
      }
      chunks.push(bytes);
    }
    const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
    if (parsed === null) {
      sendJson(response, 400, { error: "The request body must be a JSON object." });
      return null;
    }
    return parsed;
  } catch {
    if (!response.headersSent) sendJson(response, 400, { error: "The request body is not valid JSON." });
    return null;
  }
}

export function parseStreamerAction(value: unknown): StreamerAction | null {
  if (!isRecord(value) || typeof value.type !== "string") return null;
  if (value.type === "start-round" && hasOnlyKeys(value, ["type", "config"]) && isRecord(value.config)) {
    const config = value.config;
    if (!hasOnlyKeys(config, ["suggestionDurationMs", "votingDurationMs", "challengeDurationMs", "chargeGoal", "chargePerMessage"])) return null;
    if (["suggestionDurationMs", "votingDurationMs", "challengeDurationMs", "chargeGoal", "chargePerMessage"].some((key) => typeof config[key] !== "number")) return null;
    return { type: "start-round", config: config as unknown as ChallengeConfig };
  }
  if (value.type === "approve-candidates" && hasOnlyKeys(value, ["type", "suggestionIds"]) && Array.isArray(value.suggestionIds) &&
      value.suggestionIds.length <= 3 && value.suggestionIds.every((id) => typeof id === "string" && id.length <= 128)) {
    return { type: "approve-candidates", suggestionIds: value.suggestionIds as string[] };
  }
  if (["pause", "resume", "cancel", "reset"].includes(value.type) && hasOnlyKeys(value, ["type"])) {
    return { type: value.type } as StreamerAction;
  }
  return null;
}

export function describeTransitionError(error: string): string {
  const messages: Record<string, string> = {
    unauthorized: "Connect the broadcaster or start a local simulation session before changing the challenge.",
    "invalid-phase": "That action is not available during the current challenge stage.",
    "invalid-config": "Use durations from 5 seconds to 60 minutes, a positive goal, and 1–100 charge per message.",
    "invalid-candidates": "Select one to three different submitted ideas for the vote.",
    "source-mismatch": "This round belongs to a different source. Switch between Live Twitch and Demo to match it.",
    "invalid-timestamp": "The server could not validate this transition time.",
  };
  return messages[error] ?? "The challenge rejected that action.";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasOnlyKeys(value: Record<string, unknown>, expected: string[]): boolean {
  return Object.keys(value).length === expected.length && Object.keys(value).every((key) => expected.includes(key));
}

function handleConnect(
  request: IncomingMessage,
  response: ServerResponse,
  config: RuntimeConfig,
  integration: TwitchIntegration,
  rateRecords: Map<string, RateRecord>,
): void {
  const twitch = config.twitch;
  const sessions = integration.sessions;
  if (!twitch || !sessions) {
    sendJson(response, 503, { error: integration.status(null).error ?? "Twitch connection is not configured." });
    return;
  }
  const now = Date.now();
  const address = request.socket.remoteAddress ?? "unknown";
  const current = rateRecords.get(address);
  if (current && current.resetAt > now && current.count >= AUTH_START_LIMIT) {
    sendJson(response, 429, { error: "Too many Twitch connection attempts. Try again shortly." });
    return;
  }
  if (!current || current.resetAt <= now) rateRecords.set(address, { count: 1, resetAt: now + AUTH_START_WINDOW_MS });
  else current.count += 1;
  for (const [key, record] of rateRecords) {
    if (record.resetAt <= now) rateRecords.delete(key);
  }
  while (rateRecords.size > AUTH_START_MAX_ADDRESSES) {
    const oldest = rateRecords.keys().next().value as string | undefined;
    if (oldest) rateRecords.delete(oldest);
    else break;
  }

  const { state, cookieValue } = sessions.createOAuthState(now);
  const authorizationUrl = new URL("https://id.twitch.tv/oauth2/authorize");
  authorizationUrl.search = new URLSearchParams({
    client_id: twitch.clientId,
    redirect_uri: twitch.redirectUri.toString(),
    response_type: "code",
    scope: SCOPE,
    state,
  }).toString();
  appendCookie(response, buildCookie(OAUTH_STATE_COOKIE, cookieValue, {
    httpOnly: true,
    secure: twitch.secureCookies,
    sameSite: "Lax",
    path: twitch.callbackPath,
    maxAgeSeconds: 600,
  }));
  response.writeHead(302, { location: authorizationUrl.toString(), "cache-control": "no-store" });
  response.end();
}

async function handleCallback(
  url: URL,
  request: IncomingMessage,
  response: ServerResponse,
  integration: TwitchIntegration,
  config: RuntimeConfig,
): Promise<void> {
  const twitch = config.twitch;
  const sessions = integration.sessions;
  if (!twitch || !sessions) {
    sendJson(response, 503, { error: integration.status(null).error ?? "Twitch connection is not configured." });
    return;
  }
  const state = url.searchParams.get("state") ?? "";
  const stateCookie = readCookie(request, OAUTH_STATE_COOKIE);
  appendCookie(response, buildCookie(OAUTH_STATE_COOKIE, "", {
    httpOnly: true,
    secure: twitch.secureCookies,
    sameSite: "Lax",
    path: twitch.callbackPath,
    maxAgeSeconds: 0,
  }));
  if (!sessions.consumeOAuthState(state, stateCookie)) {
    sendJson(response, 400, { error: "Twitch authorization state is invalid or expired. Start the connection again." });
    return;
  }

  const providerError = url.searchParams.get("error");
  if (providerError) {
    integration.recordOAuthFailure(providerError === "access_denied" ? "denied" : "failed");
    response.writeHead(303, { location: "/", "cache-control": "no-store" });
    response.end();
    return;
  }

  const code = url.searchParams.get("code");
  if (!code || code.length > 2_048) {
    integration.recordOAuthFailure("failed");
    sendJson(response, 400, { error: "Twitch did not return a valid authorization code." });
    return;
  }
  try {
    const session = await integration.authorize(code);
    appendCookie(response, buildCookie(SESSION_COOKIE, session.cookieValue, {
      httpOnly: true,
      secure: twitch.secureCookies,
      sameSite: "Lax",
      path: "/",
      maxAgeSeconds: 12 * 60 * 60,
    }));
    response.writeHead(303, { location: "/", "cache-control": "no-store" });
    response.end();
  } catch {
    response.writeHead(303, { location: "/", "cache-control": "no-store" });
    response.end();
  }
}

async function handleDisconnect(
  request: IncomingMessage,
  response: ServerResponse,
  integration: TwitchIntegration,
): Promise<void> {
  const sessions = integration.sessions;
  const sessionCookie = readCookie(request, SESSION_COOKIE);
  const principal = sessions?.resolveSession(sessionCookie) ?? null;
  if (!principal || principal.mode !== "twitch" || !integration.status(principal).authenticatedSession) {
    sendJson(response, 401, { error: "A valid streamer session is required." });
    return;
  }
  if (!integration.redirectOrigin || request.headers.origin !== integration.redirectOrigin) {
    sendJson(response, 403, { error: "The request origin is not allowed." });
    return;
  }
  const result = await integration.disconnect();
  appendCookie(response, buildCookie(SESSION_COOKIE, "", {
    httpOnly: true,
    secure: integration.secureCookies,
    sameSite: "Lax",
    path: "/",
    maxAgeSeconds: 0,
  }));
  sendJson(response, 200, {
    disconnected: true,
    tokenRevoked: result.revoked,
    message: result.revoked ? "Twitch disconnected." : "Twitch disconnected locally; token revocation could not be confirmed.",
  });
}

function buildCookie(
  name: string,
  value: string,
  options: { httpOnly: boolean; secure: boolean; sameSite: "Lax"; path: string; maxAgeSeconds: number },
): string {
  const parts = [`${name}=${encodeURIComponent(value)}`, `Path=${options.path}`, `Max-Age=${options.maxAgeSeconds}`, `SameSite=${options.sameSite}`];
  if (options.httpOnly) parts.push("HttpOnly");
  if (options.secure) parts.push("Secure");
  return parts.join("; ");
}

function appendCookie(response: ServerResponse, cookie: string): void {
  const current = response.getHeader("set-cookie");
  const cookies = Array.isArray(current) ? current : typeof current === "string" ? [current] : [];
  response.setHeader("set-cookie", [...cookies, cookie]);
}

function readCookie(request: IncomingMessage, name: string): string | null {
  const header = request.headers.cookie;
  if (!header) return null;
  for (const part of header.split(";")) {
    const separator = part.indexOf("=");
    if (separator < 0 || part.slice(0, separator).trim() !== name) continue;
    try {
      return decodeURIComponent(part.slice(separator + 1).trim());
    } catch {
      return null;
    }
  }
  return null;
}

function sendJson(response: ServerResponse, status: number, value: unknown): void {
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  response.end(JSON.stringify(value));
}

function applySecurityHeaders(response: ServerResponse, config: RuntimeConfig): void {
  response.setHeader("x-content-type-options", "nosniff");
  response.setHeader("referrer-policy", "no-referrer");
  response.setHeader("x-frame-options", "DENY");
  const stateSocketOrigin = config.twitch?.redirectUri.origin.replace(/^https:/, "wss:").replace(/^http:/, "ws:") ?? "'self'";
  const policy = process.env.NODE_ENV === "production"
    ? `default-src 'self'; base-uri 'self'; object-src 'none'; frame-ancestors 'none'; form-action 'self' https://id.twitch.tv; connect-src 'self' ${stateSocketOrigin}; script-src 'self'; style-src 'self'; img-src 'self' data:`
    : "default-src 'self'; base-uri 'self'; object-src 'none'; frame-ancestors 'none'; form-action 'self' https://id.twitch.tv; connect-src 'self' ws:; script-src 'self' 'unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' data:";
  response.setHeader("content-security-policy", policy);
}

