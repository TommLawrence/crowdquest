import { normalizeChatNotification, type IncomingChatMessage } from "./chat-message.js";
import { TwitchApiError, type TwitchApi } from "./twitch-api.js";

const EVENTSUB_URL = "wss://eventsub.wss.twitch.tv/ws?keepalive_timeout_seconds=30";
const MAX_DEDUPLICATION_IDS = 4_096;
const MAX_BACKOFF_MS = 30_000;

export type EventSubConnectionState = "stopped" | "connecting" | "connected" | "reconnecting" | "error";
export type EventSubSubscriptionState = "none" | "pending" | "enabled" | "revoked" | "error";

export interface EventSubStatus {
  connection: EventSubConnectionState;
  subscription: EventSubSubscriptionState;
  reconnectAttempts: number;
  lastMessageAt: number | null;
  error: string | null;
}

export interface EventSubSocket {
  addEventListener(type: string, listener: (event: EventSubSocketEvent) => void): void;
  close(code?: number, reason?: string): void;
}

export interface EventSubSocketEvent {
  data?: unknown;
  code?: number;
}

export interface EventSubOptions {
  broadcasterId: string;
  api: TwitchApi;
  getAccessToken: () => Promise<string>;
  refreshAfterUnauthorized: () => Promise<string>;
  onChatMessage: (message: IncomingChatMessage) => void;
  onStatus: (status: EventSubStatus) => void;
  onAuthorizationLost: () => Promise<void>;
  socketFactory?: (url: string) => EventSubSocket;
  now?: () => number;
}

interface SocketContext {
  transferFrom: EventSubSocket | null;
  welcomed: boolean;
}

export class EventSubClient {
  private readonly socketFactory: (url: string) => EventSubSocket;
  private readonly now: () => number;
  private readonly socketContexts = new Map<EventSubSocket, SocketContext>();
  private readonly notificationIds = new BoundedIdSet(MAX_DEDUPLICATION_IDS);
  private readonly chatMessageIds = new BoundedIdSet(MAX_DEDUPLICATION_IDS);
  private currentSocket: EventSubSocket | null = null;
  private transferSocket: EventSubSocket | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private watchdogTimer: ReturnType<typeof setInterval> | null = null;
  private readonly welcomeTimers = new Map<EventSubSocket, ReturnType<typeof setTimeout>>();
  private stopped = true;
  private fatalAuthorizationFailure = false;
  private keepaliveTimeoutMs = 30_000;
  private lastFrameAt = 0;
  private subscriptionId: string | null = null;
  private reconnectAttempts = 0;
  private statusValue: EventSubStatus = {
    connection: "stopped",
    subscription: "none",
    reconnectAttempts: 0,
    lastMessageAt: null,
    error: null,
  };

  constructor(private readonly options: EventSubOptions) {
    this.socketFactory = options.socketFactory ?? ((url) => new WebSocket(url) as unknown as EventSubSocket);
    this.now = options.now ?? Date.now;
  }

  get status(): EventSubStatus {
    return { ...this.statusValue };
  }

  start(): void {
    this.stopSocketsAndTimers();
    this.stopped = false;
    this.fatalAuthorizationFailure = false;
    this.reconnectAttempts = 0;
    this.subscriptionId = null;
    this.updateStatus({ connection: "connecting", subscription: "pending", error: null, reconnectAttempts: 0 });
    this.openSocket(EVENTSUB_URL, null);
    this.watchdogTimer = setInterval(() => this.checkKeepalive(), 1_000);
  }

  stop(): void {
    this.stopped = true;
    this.fatalAuthorizationFailure = false;
    this.stopSocketsAndTimers();
    this.currentSocket = null;
    this.transferSocket = null;
    this.subscriptionId = null;
    this.reconnectAttempts = 0;
    this.updateStatus({
      connection: "stopped",
      subscription: "none",
      reconnectAttempts: 0,
      lastMessageAt: null,
      error: null,
    });
  }

  private openSocket(url: string, transferFrom: EventSubSocket | null): void {
    if (this.stopped) return;
    let socket: EventSubSocket;
    try {
      socket = this.socketFactory(url);
    } catch {
      if (transferFrom) {
        this.transferSocket = null;
        this.updateStatus({ connection: "connected", error: "Twitch session transfer failed; keeping the current connection." });
      } else {
        this.handleConnectionFailure("Could not open the Twitch EventSub connection.");
      }
      return;
    }
    this.socketContexts.set(socket, { transferFrom, welcomed: false });
    if (transferFrom) this.transferSocket = socket;
    else this.currentSocket = socket;
    this.welcomeTimers.set(socket, setTimeout(() => {
      if (this.socketContexts.get(socket)?.welcomed) return;
      this.updateStatus({ connection: "error", error: "Twitch EventSub did not send a welcome message in time." });
      socket.close(1011, "welcome timeout");
    }, 9_000));
    socket.addEventListener("message", (event) => {
      void this.handleFrame(socket, event.data).catch(() => {
        this.updateStatus({ connection: "error", error: "Could not process a Twitch EventSub message." });
      });
    });
    socket.addEventListener("close", (event) => this.handleClose(socket, event.code));
    socket.addEventListener("error", () => {
      if (!this.stopped) this.updateStatus({ connection: "error", error: "Twitch EventSub reported a network error." });
    });
  }

  private async handleFrame(socket: EventSubSocket, data: unknown): Promise<void> {
    if (this.stopped || !this.socketContexts.has(socket)) return;
    this.lastFrameAt = this.now();
    let envelope: unknown;
    try {
      const serialized = typeof data === "string" ? data : await dataToString(data);
      if (serialized.length > 256_000) throw new Error("Frame is too large.");
      envelope = JSON.parse(serialized) as unknown;
    } catch {
      this.updateStatus({ error: "Twitch sent an unreadable EventSub message." });
      return;
    }
    if (!isRecord(envelope) || !isRecord(envelope.metadata) || typeof envelope.metadata.message_type !== "string") return;
    const notificationId = typeof envelope.metadata.message_id === "string" ? envelope.metadata.message_id : null;
    const messageType = envelope.metadata.message_type;

    if (messageType === "session_welcome") {
      await this.handleWelcome(socket, envelope);
      return;
    }
    if (notificationId && this.notificationIds.hasOrAdd(notificationId)) return;
    if (messageType === "session_keepalive") return;
    if (messageType === "session_reconnect") {
      this.handleReconnect(socket, envelope);
      return;
    }
    if (messageType === "revocation") {
      await this.handleRevocation(envelope);
      return;
    }
    if (messageType === "notification") this.handleNotification(envelope);
  }

  private async handleWelcome(socket: EventSubSocket, envelope: Record<string, unknown>): Promise<void> {
    const context = this.socketContexts.get(socket);
    if (!context || context.welcomed || !isRecord(envelope.payload) || !isRecord(envelope.payload.session)) return;
    const session = envelope.payload.session;
    if (
      typeof session.id !== "string" ||
      !Number.isInteger(session.keepalive_timeout_seconds) ||
      (session.keepalive_timeout_seconds as number) < 10 ||
      (session.keepalive_timeout_seconds as number) > 600
    ) {
      this.updateStatus({ connection: "error", error: "Twitch sent an invalid EventSub welcome message." });
      socket.close(1011, "invalid welcome");
      return;
    }
    context.welcomed = true;
    const welcomeTimer = this.welcomeTimers.get(socket);
    if (welcomeTimer) clearTimeout(welcomeTimer);
    this.welcomeTimers.delete(socket);
    this.keepaliveTimeoutMs = (session.keepalive_timeout_seconds as number) * 1_000;
    this.lastFrameAt = this.now();

    if (context.transferFrom) {
      const priorSocket = context.transferFrom;
      this.currentSocket = socket;
      this.transferSocket = null;
      this.reconnectAttempts = 0;
      this.updateStatus({ connection: "connected", subscription: this.subscriptionId ? "enabled" : "pending", reconnectAttempts: 0, error: null });
      priorSocket.close(1000, "EventSub session transferred");
      return;
    }

    this.currentSocket = socket;
    this.updateStatus({ connection: "connected", subscription: "pending", error: null });
    try {
      let accessToken = await this.options.getAccessToken();
      let createdSubscriptionId: string;
      try {
        createdSubscriptionId = await this.options.api.createChatSubscription(accessToken, this.options.broadcasterId, session.id);
      } catch (error) {
        if (!(error instanceof TwitchApiError) || error.status !== 401) throw error;
        accessToken = await this.options.refreshAfterUnauthorized();
        createdSubscriptionId = await this.options.api.createChatSubscription(accessToken, this.options.broadcasterId, session.id);
      }
      if (this.currentSocket !== socket || this.stopped) return;
      this.subscriptionId = createdSubscriptionId;
      this.reconnectAttempts = 0;
      this.updateStatus({ connection: "connected", subscription: "enabled", reconnectAttempts: 0, error: null });
    } catch (error) {
      if (error instanceof TwitchApiError && [401, 403].includes(error.status)) {
        this.fatalAuthorizationFailure = true;
        this.updateStatus({ connection: "error", subscription: "error", error: "Twitch authorization needs to be reconnected." });
        await this.options.onAuthorizationLost();
      } else {
        this.updateStatus({ connection: "error", subscription: "error", error: error instanceof TwitchApiError && error.status === 400 ? "Twitch rejected the chat subscription request." : "Could not subscribe to Twitch chat." });
      }
      socket.close(1011, "subscription setup failed");
    }
  }

  private handleReconnect(socket: EventSubSocket, envelope: Record<string, unknown>): void {
    if (socket !== this.currentSocket || this.transferSocket || !isRecord(envelope.payload) || !isRecord(envelope.payload.session)) return;
    const reconnectUrl = envelope.payload.session.reconnect_url;
    if (typeof reconnectUrl !== "string") {
      this.updateStatus({ connection: "error", error: "Twitch sent an invalid reconnect instruction." });
      return;
    }
    let parsedUrl: URL;
    try {
      parsedUrl = new URL(reconnectUrl);
    } catch {
      this.updateStatus({ connection: "error", error: "Twitch sent an invalid reconnect instruction." });
      return;
    }
    if (parsedUrl.protocol !== "wss:" || parsedUrl.hostname !== "eventsub.wss.twitch.tv") {
      this.updateStatus({ connection: "error", error: "Twitch sent an invalid reconnect instruction." });
      return;
    }
    this.updateStatus({ connection: "reconnecting", error: null });
    this.openSocket(reconnectUrl, socket);
  }

  private async handleRevocation(envelope: Record<string, unknown>): Promise<void> {
    if (!isRecord(envelope.payload) || !isRecord(envelope.payload.subscription)) return;
    const subscription = envelope.payload.subscription;
    if (subscription.type !== "channel.chat.message") return;
    this.fatalAuthorizationFailure = true;
    this.stopped = true;
    const status = typeof subscription.status === "string" ? subscription.status : "revoked";
    const needsAuthorization = status === "authorization_revoked" || status === "user_removed";
    const reason = needsAuthorization
      ? "Twitch authorization was revoked. Reconnect the channel."
      : "Twitch removed the chat subscription. Review the Twitch app and reconnect if appropriate.";
    this.updateStatus({ connection: "error", subscription: "revoked", error: reason });
    this.stopSocketsAndTimers();
    this.currentSocket = null;
    this.transferSocket = null;
    if (needsAuthorization) await this.options.onAuthorizationLost();
  }

  private handleNotification(envelope: Record<string, unknown>): void {
    const normalized = normalizeChatNotification(envelope, this.options.broadcasterId, this.now());
    if (!normalized || this.chatMessageIds.hasOrAdd(normalized.messageId)) return;
    this.updateStatus({ lastMessageAt: normalized.timestamp });
    this.options.onChatMessage(normalized);
  }

  private handleClose(socket: EventSubSocket, _code?: number): void {
    const welcomeTimer = this.welcomeTimers.get(socket);
    if (welcomeTimer) clearTimeout(welcomeTimer);
    this.welcomeTimers.delete(socket);
    const context = this.socketContexts.get(socket);
    this.socketContexts.delete(socket);
    if (this.stopped || this.fatalAuthorizationFailure) return;

    if (context?.transferFrom) {
      if (this.transferSocket === socket) this.transferSocket = null;
      if (this.currentSocket === context.transferFrom) {
        this.updateStatus({ connection: "connected", error: "Twitch session transfer did not complete; retaining the current connection." });
      }
      return;
    }
    if (socket !== this.currentSocket) return;

    this.currentSocket = null;
    if (this.transferSocket) {
      this.transferSocket.close(1000, "Old EventSub session closed");
      this.transferSocket = null;
    }
    this.subscriptionId = null;
    this.updateStatus({ connection: "reconnecting", subscription: "pending", error: "Twitch chat connection was lost; reconnecting." });
    this.scheduleReconnect();
  }

  private handleConnectionFailure(error: string): void {
    this.updateStatus({ connection: "error", error });
    this.scheduleReconnect();
  }

  private scheduleReconnect(): void {
    if (this.stopped || this.fatalAuthorizationFailure || this.reconnectTimer) return;
    const delay = Math.min(1_000 * 2 ** Math.min(this.reconnectAttempts, 5), MAX_BACKOFF_MS);
    this.reconnectAttempts += 1;
    this.updateStatus({ connection: "reconnecting", subscription: "pending", reconnectAttempts: this.reconnectAttempts });
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.openSocket(EVENTSUB_URL, null);
    }, delay);
  }

  private checkKeepalive(): void {
    if (this.stopped || !this.currentSocket || !this.lastFrameAt) return;
    if (this.now() - this.lastFrameAt > this.keepaliveTimeoutMs) {
      this.updateStatus({ connection: "error", error: "Twitch EventSub keepalive timed out." });
      this.currentSocket.close(1011, "keepalive timeout");
    }
  }

  private stopSocketsAndTimers(): void {
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    if (this.watchdogTimer) clearInterval(this.watchdogTimer);
    this.reconnectTimer = null;
    this.watchdogTimer = null;
    for (const timer of this.welcomeTimers.values()) clearTimeout(timer);
    this.welcomeTimers.clear();
    const sockets = new Set([...this.socketContexts.keys(), this.currentSocket, this.transferSocket].filter(isEventSubSocket));
    this.socketContexts.clear();
    for (const socket of sockets) socket.close(1000, "EventSub client stopped");
  }

  private updateStatus(patch: Partial<EventSubStatus>): void {
    this.statusValue = { ...this.statusValue, ...patch };
    this.options.onStatus(this.status);
  }
}

class BoundedIdSet {
  private readonly values = new Set<string>();

  constructor(private readonly maximumSize: number) {}

  hasOrAdd(id: string): boolean {
    if (this.values.has(id)) return true;
    this.values.add(id);
    if (this.values.size > this.maximumSize) {
      const oldest = this.values.values().next().value as string | undefined;
      if (oldest) this.values.delete(oldest);
    }
    return false;
  }
}

async function dataToString(data: unknown): Promise<string> {
  if (typeof data === "string") return data;
  if (data instanceof ArrayBuffer) return new TextDecoder().decode(data);
  if (ArrayBuffer.isView(data)) return new TextDecoder().decode(data);
  if (typeof Blob !== "undefined" && data instanceof Blob) return data.text();
  throw new Error("Unsupported EventSub frame data.");
}

function isEventSubSocket(value: unknown): value is EventSubSocket {
  return typeof value === "object" && value !== null && "close" in value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
