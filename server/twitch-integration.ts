import { randomBytes } from "node:crypto";
import type { ChallengeState } from "../src/domain/challenge.js";
import type { RuntimeConfig } from "./config.js";
import { ChatRuntime, type CommandDiagnostic } from "./chat-runtime.js";
import type { EventSubStatus } from "./eventsub.js";
import { EventSubClient } from "./eventsub.js";
import { SessionManager, type SessionPrincipal, type StreamerIdentity } from "./session.js";
import { EncryptedTokenStore } from "./token-store.js";
import { TwitchApi, TwitchApiError } from "./twitch-api.js";
import { TwitchAuthService } from "./twitch-auth.js";

export interface TwitchStatusSnapshot {
  configured: boolean;
  authorized: boolean;
  authenticatedSession: boolean;
  sessionMode: "twitch" | "simulation" | null;
  broadcaster: StreamerIdentity | null;
  eventSub: EventSubStatus;
  messagesReceived: number;
  lastMessageAt: number | null;
  latestCommand: CommandDiagnostic | null;
  error: string | null;
}

const EMPTY_EVENTSUB_STATUS: EventSubStatus = {
  connection: "stopped",
  subscription: "none",
  reconnectAttempts: 0,
  lastMessageAt: null,
  error: null,
};

export class TwitchIntegration {
  readonly sessions: SessionManager | null;
  private readonly auth: TwitchAuthService | null;
  private readonly api: TwitchApi | null;
  private eventSub: EventSubClient | null = null;
  private eventSubStatus: EventSubStatus = { ...EMPTY_EVENTSUB_STATUS };
  private readonly chatRuntime: ChatRuntime;
  private maintenanceTimer: ReturnType<typeof setInterval> | null = null;
  private error: string | null = null;

  constructor(
    private readonly runtimeConfig: RuntimeConfig,
    getChallengeState: () => ChallengeState,
    setChallengeState: (state: ChallengeState) => void,
    private readonly onStateChange: () => void = () => {},
    chatRuntime?: ChatRuntime,
  ) {
    const config = runtimeConfig.twitch;
    this.chatRuntime = chatRuntime ?? new ChatRuntime(getChallengeState, setChallengeState, Date.now, () => null, onStateChange);
    this.sessions = config
      ? new SessionManager(config.sessionSecret)
      : runtimeConfig.simulatedChatEnabled && process.env.NODE_ENV !== "production"
        ? new SessionManager(randomBytes(32))
        : null;
    if (!config) {
      this.auth = null;
      this.api = null;
      this.error = runtimeConfig.configurationError;
      return;
    }
    this.api = new TwitchApi(config);
    this.auth = new TwitchAuthService(
      { clientId: config.clientId },
      this.api,
      new EncryptedTokenStore(config.dataFile, config.tokenEncryptionKey),
    );
  }

  get isConfigured(): boolean {
    return this.runtimeConfig.twitch !== null;
  }

  get callbackPath(): string | null {
    return this.runtimeConfig.twitch?.callbackPath ?? null;
  }

  get redirectOrigin(): string | null {
    return this.runtimeConfig.twitch?.redirectUri.origin ?? null;
  }

  get secureCookies(): boolean {
    return this.runtimeConfig.twitch?.secureCookies ?? false;
  }

  async initialize(): Promise<void> {
    if (!this.auth) {
      this.onStateChange();
      return;
    }
    try {
      const stored = await this.auth.restore();
      if (stored) this.startEventSub(stored.identity.id);
      this.startMaintenance();
    } catch (error) {
      this.error = error instanceof TwitchApiError && error.category === "network"
        ? "Could not reach Twitch to verify the saved connection. Retry by reconnecting Twitch."
        : "Saved Twitch authorization could not be verified. Reconnect Twitch.";
    }
    this.onStateChange();
  }

  async authorize(code: string): Promise<{ cookieValue: string; principal: SessionPrincipal }> {
    if (!this.auth || !this.sessions) throw new Error("Twitch connection is not configured.");
    try {
      const stored = await this.auth.completeAuthorization(code);
      this.eventSub?.stop();
      this.sessions.clearSessions();
      const session = this.sessions.createSession(stored.identity);
      this.error = null;
      this.startEventSub(stored.identity.id);
      this.startMaintenance();
      this.onStateChange();
      return session;
    } catch (error) {
      this.error = safeOAuthError(error);
      this.onStateChange();
      throw error;
    }
  }

  async disconnect(): Promise<{ revoked: boolean }> {
    this.eventSub?.stop();
    this.eventSub = null;
    this.eventSubStatus = { ...EMPTY_EVENTSUB_STATUS };
    if (this.maintenanceTimer) clearInterval(this.maintenanceTimer);
    this.maintenanceTimer = null;
    this.sessions?.clearSessions();
    this.error = null;
    const result = this.auth ? await this.auth.disconnect() : { revoked: false };
    this.onStateChange();
    return result;
  }

  recordOAuthFailure(kind: "denied" | "failed"): void {
    this.error = kind === "denied"
      ? "Twitch authorization was cancelled. You can connect again when ready."
      : "Twitch authorization could not be completed. Check the connection status and try again.";
    this.onStateChange();
  }

  async stop(): Promise<void> {
    if (this.maintenanceTimer) clearInterval(this.maintenanceTimer);
    this.maintenanceTimer = null;
    this.eventSub?.stop();
    this.eventSub = null;
    this.onStateChange();
  }

  status(principal: SessionPrincipal | null): TwitchStatusSnapshot {
    const authIdentity = this.auth?.identity ?? null;
    const hasValidSession = principal !== null && authIdentity?.id === principal.id;
    const chat = this.chatRuntime.snapshot();
    return {
      configured: this.isConfigured,
      authorized: this.auth?.isConnected ?? false,
      authenticatedSession: hasValidSession,
      sessionMode: principal?.mode ?? null,
      broadcaster: hasValidSession ? authIdentity : null,
      eventSub: { ...this.eventSubStatus },
      messagesReceived: chat.messagesReceived,
      lastMessageAt: chat.lastMessageAt,
      latestCommand: chat.latestCommand ? { ...chat.latestCommand } : null,
      error: this.error ?? this.eventSubStatus.error ?? this.runtimeConfig.configurationError,
    };
  }

  private startEventSub(broadcasterId: string): void {
    if (!this.auth || !this.api) return;
    this.eventSub?.stop();
    this.eventSub = new EventSubClient({
      broadcasterId,
      api: this.api,
      getAccessToken: () => this.auth!.getAccessToken(),
      refreshAfterUnauthorized: async () => {
        try {
          return await this.auth!.refreshAfterUnauthorized();
        } catch (error) {
          if (error instanceof TwitchApiError && [400, 401, 403].includes(error.status)) {
            await this.authorizationLost();
          }
          throw error;
        }
      },
      onChatMessage: (message) => this.chatRuntime.receive(message, "live"),
      onStatus: (status) => {
        this.eventSubStatus = status;
        if (status.connection === "connected" && status.subscription === "enabled") this.error = null;
        this.onStateChange();
      },
      onAuthorizationLost: () => this.authorizationLost(),
    });
    this.eventSub.start();
  }

  private async authorizationLost(): Promise<void> {
    const previousStatus = this.eventSubStatus;
    this.eventSub?.stop();
    this.eventSub = null;
    this.sessions?.clearSessions();
    try {
      await this.auth?.clearInvalidAuthorization();
    } catch {
      this.error = "Twitch authorization expired; reconnect Twitch. Stored token cleanup needs attention.";
      this.eventSubStatus = {
        ...previousStatus,
        connection: "error",
        subscription: previousStatus.subscription === "revoked" ? "revoked" : "error",
        error: this.error,
      };
      this.onStateChange();
      return;
    }
    this.error = "Twitch authorization expired or was revoked. Reconnect Twitch.";
    this.eventSubStatus = {
      ...previousStatus,
      connection: "error",
      subscription: previousStatus.subscription === "revoked" ? "revoked" : "error",
      error: this.error,
    };
    this.onStateChange();
  }

  private startMaintenance(): void {
    if (this.maintenanceTimer || !this.auth) return;
    this.maintenanceTimer = setInterval(() => {
      void this.auth?.revalidate().then((stored) => {
        if (!stored) {
          const previousStatus = this.eventSubStatus;
          this.eventSub?.stop();
          this.eventSub = null;
          this.sessions?.clearSessions();
          this.error = "Twitch authorization expired. Reconnect Twitch.";
          this.eventSubStatus = {
            ...previousStatus,
            connection: "error",
            subscription: previousStatus.subscription === "revoked" ? "revoked" : "error",
            error: this.error,
          };
          this.onStateChange();
        } else if (this.error?.startsWith("Could not reach Twitch")) {
          this.error = null;
          this.onStateChange();
        }
      }).catch(() => {
        this.error = "Could not reach Twitch to verify the connection. Retrying authorization check.";
        this.onStateChange();
      });
    }, 60 * 60 * 1_000);
  }
}

function safeOAuthError(error: unknown): string {
  if (error instanceof TwitchApiError && error.status === 403) {
    return "Twitch did not grant the required chat-reading permission. Reconnect and approve user:read:chat.";
  }
  if (error instanceof TwitchApiError && error.category === "network") {
    return "Could not reach Twitch during authorization. Try connecting again.";
  }
  return "Twitch authorization could not be completed. Check the app configuration and try again.";
}
