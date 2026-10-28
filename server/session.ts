import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

export interface StreamerIdentity {
  id: string;
  login: string;
  displayName: string;
}

export interface SessionPrincipal extends StreamerIdentity {
  readonly authenticatedByServerSession: true;
  readonly mode: "twitch" | "simulation";
}

interface SessionRecord {
  principal: SessionPrincipal;
  expiresAt: number;
}

interface OAuthStateRecord {
  expiresAt: number;
}

const SESSION_LIFETIME_MS = 12 * 60 * 60 * 1_000;
const OAUTH_STATE_LIFETIME_MS = 10 * 60 * 1_000;
const MAX_SESSION_COUNT = 100;
const MAX_STATE_COUNT = 100;

export class SessionManager {
  private readonly sessions = new Map<string, SessionRecord>();
  private readonly states = new Map<string, OAuthStateRecord>();

  constructor(private readonly secret: Buffer) {}

  createOAuthState(nowMs = Date.now()): { state: string; cookieValue: string } {
    this.prune(nowMs);
    if (this.states.size >= MAX_STATE_COUNT) {
      const oldestState = this.states.keys().next().value as string | undefined;
      if (oldestState) this.states.delete(oldestState);
    }
    const state = randomBytes(32).toString("base64url");
    this.states.set(state, { expiresAt: nowMs + OAUTH_STATE_LIFETIME_MS });
    return { state, cookieValue: this.signedValue("oauth-state", state) };
  }

  consumeOAuthState(state: string, cookieValue: string | null, nowMs = Date.now()): boolean {
    this.prune(nowMs);
    if (!cookieValue || state.length > 128) return false;
    const [cookieState, signature, extra] = cookieValue.split(".");
    if (extra !== undefined || !cookieState || !signature || !safeEqual(cookieState, state)) return false;
    if (!this.verifyValue("oauth-state", cookieState, signature)) return false;
    const record = this.states.get(state);
    if (!record || record.expiresAt <= nowMs) return false;
    this.states.delete(state);
    return true;
  }

  createSession(
    identity: StreamerIdentity,
    nowMs = Date.now(),
    mode: SessionPrincipal["mode"] = "twitch",
  ): { cookieValue: string; principal: SessionPrincipal } {
    this.prune(nowMs);
    const sessionId = randomBytes(32).toString("base64url");
    const principal: SessionPrincipal = {
      id: identity.id,
      login: identity.login,
      displayName: identity.displayName,
      authenticatedByServerSession: true,
      mode,
    };
    this.sessions.set(sessionId, { principal, expiresAt: nowMs + SESSION_LIFETIME_MS });
    while (this.sessions.size > MAX_SESSION_COUNT) {
      const oldestSession = this.sessions.keys().next().value as string | undefined;
      if (oldestSession) this.sessions.delete(oldestSession);
    }
    return { cookieValue: this.signedValue("session", sessionId), principal };
  }

  createSimulationSession(nowMs = Date.now()): { cookieValue: string; principal: SessionPrincipal } {
    return this.createSession({
      id: "local-simulation-operator",
      login: "local-simulation",
      displayName: "Local Demo Operator",
    }, nowMs, "simulation");
  }

  resolveSession(cookieValue: string | null, nowMs = Date.now()): SessionPrincipal | null {
    this.prune(nowMs);
    if (!cookieValue) return null;
    const [sessionId, signature, extra] = cookieValue.split(".");
    if (extra !== undefined || !sessionId || !signature || !this.verifyValue("session", sessionId, signature)) return null;
    const record = this.sessions.get(sessionId);
    if (!record || record.expiresAt <= nowMs) return null;
    return record.principal;
  }

  revokeSession(cookieValue: string | null): boolean {
    if (!cookieValue) return false;
    const [sessionId, signature, extra] = cookieValue.split(".");
    if (extra !== undefined || !sessionId || !signature || !this.verifyValue("session", sessionId, signature)) return false;
    return this.sessions.delete(sessionId);
  }

  clearSessions(): void {
    this.sessions.clear();
  }

  private signedValue(purpose: string, payload: string): string {
    const signature = createHmac("sha256", this.secret).update(`${purpose}:${payload}`).digest("base64url");
    return `${payload}.${signature}`;
  }

  private verifyValue(purpose: string, payload: string, provided: string): boolean {
    const expected = createHmac("sha256", this.secret).update(`${purpose}:${payload}`).digest("base64url");
    return safeEqual(expected, provided);
  }

  private prune(nowMs: number): void {
    for (const [state, record] of this.states) {
      if (record.expiresAt <= nowMs) this.states.delete(state);
    }
    for (const [sessionId, record] of this.sessions) {
      if (record.expiresAt <= nowMs) this.sessions.delete(sessionId);
    }
  }
}

function safeEqual(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left);
  const rightBytes = Buffer.from(right);
  return leftBytes.length === rightBytes.length && timingSafeEqual(leftBytes, rightBytes);
}
