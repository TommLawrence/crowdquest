import { afterEach, describe, expect, it, vi } from "vitest";
import { EventSubClient, type EventSubSocket, type EventSubSocketEvent } from "./eventsub.js";
import { TwitchApiError, type TwitchApi } from "./twitch-api.js";

class FakeSocket implements EventSubSocket {
  readonly listeners = new Map<string, ((event: EventSubSocketEvent) => void)[]>();
  closed = false;
  closeCode: number | undefined;

  addEventListener(type: string, listener: (event: EventSubSocketEvent) => void): void {
    const listeners = this.listeners.get(type) ?? [];
    listeners.push(listener);
    this.listeners.set(type, listeners);
  }

  close(code = 1000): void {
    if (this.closed) return;
    this.closed = true;
    this.closeCode = code;
    this.emit("close", { code });
  }

  sendMessage(message: unknown): void {
    this.emit("message", { data: JSON.stringify(message) });
  }

  private emit(type: string, event: EventSubSocketEvent): void {
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }
}

function welcome(id: string) {
  return {
    metadata: { message_id: `welcome-${id}`, message_type: "session_welcome" },
    payload: { session: { id, keepalive_timeout_seconds: 30, reconnect_url: null } },
  };
}

function chatNotification(notificationId: string, messageId = "chat-id") {
  return {
    metadata: {
      message_id: notificationId,
      message_type: "notification",
      subscription_type: "channel.chat.message",
      message_timestamp: "2026-10-27T12:00:00Z",
    },
    payload: {
      subscription: {
        id: "sub-id",
        type: "channel.chat.message",
        version: "1",
        status: "enabled",
        condition: { broadcaster_user_id: "streamer-id", user_id: "streamer-id" },
      },
      event: {
        broadcaster_user_id: "streamer-id",
        chatter_user_id: "viewer-id",
        chatter_user_login: "viewer",
        chatter_user_name: "Viewer",
        message_id: messageId,
        message: { text: "!charge" },
      },
    },
  };
}

function setup(apiOverrides: Partial<TwitchApi> = {}, onAuthorizationLost = vi.fn(async () => {})) {
  const sockets: FakeSocket[] = [];
  const api = {
    createChatSubscription: vi.fn(async () => "sub-id"),
    ...apiOverrides,
  } as unknown as TwitchApi;
  const onChatMessage = vi.fn();
  const onStatus = vi.fn();
  const client = new EventSubClient({
    broadcasterId: "streamer-id",
    api,
    getAccessToken: vi.fn(async () => "access-token"),
    refreshAfterUnauthorized: vi.fn(async () => "refreshed-access-token"),
    onChatMessage,
    onStatus,
    onAuthorizationLost,
    socketFactory: vi.fn(() => {
      const socket = new FakeSocket();
      sockets.push(socket);
      return socket;
    }),
  });
  return { client, sockets, api, onChatMessage, onStatus, onAuthorizationLost };
}

async function flush(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

afterEach(() => {
  vi.useRealTimers();
});

describe("EventSub WebSocket lifecycle", () => {
  it("subscribes after welcome with the broadcaster as both user IDs", async () => {
    const { client, sockets, api } = setup();
    client.start();
    sockets[0]?.sendMessage(welcome("session-1"));
    await flush();

    expect(api.createChatSubscription).toHaveBeenCalledWith("access-token", "streamer-id", "session-1");
    expect(client.status).toMatchObject({ connection: "connected", subscription: "enabled" });
    client.stop();
  });

  it("refreshes authorization once when EventSub subscription creation returns 401", async () => {
    const createChatSubscription = vi.fn()
      .mockRejectedValueOnce(new TwitchApiError(401, "authorization"))
      .mockResolvedValueOnce("sub-id");
    const { client, sockets } = setup({ createChatSubscription });
    client.start();
    sockets[0]?.sendMessage(welcome("session-1"));
    await flush();

    expect(createChatSubscription).toHaveBeenCalledTimes(2);
    expect(createChatSubscription).toHaveBeenLastCalledWith("refreshed-access-token", "streamer-id", "session-1");
    expect(client.status.subscription).toBe("enabled");
    client.stop();
  });

  it("ignores malformed notifications and deduplicates both notification and chat message IDs", async () => {
    const { client, sockets, onChatMessage } = setup();
    client.start();
    const socket = sockets[0];
    socket?.sendMessage(welcome("session-1"));
    await flush();
    socket?.sendMessage({ metadata: { message_type: "notification", message_id: "bad", subscription_type: "channel.chat.message" }, payload: {} });
    socket?.sendMessage(chatNotification("notification-1", "same-chat-message"));
    socket?.sendMessage(chatNotification("notification-2", "same-chat-message"));
    socket?.sendMessage(chatNotification("notification-1", "different-chat-message"));
    await flush();

    expect(onChatMessage).toHaveBeenCalledTimes(1);
    expect(client.status.lastMessageAt).toBe(Date.parse("2026-10-27T12:00:00Z"));
    client.stop();
  });

  it("reconnects after an ordinary disconnect and creates a fresh subscription", async () => {
    vi.useFakeTimers();
    const { client, sockets, api } = setup();
    client.start();
    sockets[0]?.sendMessage(welcome("session-1"));
    await flush();
    sockets[0]?.close(1006);
    expect(client.status.connection).toBe("reconnecting");

    await vi.advanceTimersByTimeAsync(1_000);
    expect(sockets).toHaveLength(2);
    sockets[1]?.sendMessage(welcome("session-2"));
    await flush();
    expect(api.createChatSubscription).toHaveBeenCalledTimes(2);
    expect(client.status).toMatchObject({ connection: "connected", subscription: "enabled" });
    client.stop();
  });

  it("detects a stale keepalive window and reconnects", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-27T12:00:00Z"));
    const { client, sockets, onStatus } = setup();
    client.start();
    sockets[0]?.sendMessage(welcome("session-1"));
    await flush();
    await vi.advanceTimersByTimeAsync(31_000);

    expect(sockets[0]?.closed).toBe(true);
    expect(onStatus.mock.calls.some(([status]) => status.error === "Twitch EventSub keepalive timed out.")).toBe(true);
    client.stop();
  });

  it("transfers sessions with Twitch reconnect URL and keeps the old socket until welcome", async () => {
    const { client, sockets, api } = setup();
    client.start();
    sockets[0]?.sendMessage(welcome("session-1"));
    await flush();
    sockets[0]?.sendMessage({
      metadata: { message_id: "reconnect-1", message_type: "session_reconnect" },
      payload: { session: { reconnect_url: "wss://eventsub.wss.twitch.tv/ws?session_id=transfer" } },
    });
    expect(sockets).toHaveLength(2);
    expect(sockets[0]?.closed).toBe(false);
    sockets[1]?.sendMessage(welcome("session-2"));
    await flush();

    expect(sockets[0]?.closed).toBe(true);
    expect(client.status).toMatchObject({ connection: "connected", subscription: "enabled" });
    expect(api.createChatSubscription).toHaveBeenCalledTimes(1);
    client.stop();
  });

  it("stops retrying after authorization failure and reports a sanitized error", async () => {
    const onAuthorizationLost = vi.fn(async () => {});
    const { client, sockets } = setup({
      createChatSubscription: vi.fn(async () => { throw new TwitchApiError(401, "authorization"); }),
    }, onAuthorizationLost);
    client.start();
    sockets[0]?.sendMessage(welcome("session-1"));
    await flush();

    expect(onAuthorizationLost).toHaveBeenCalledTimes(1);
    expect(client.status.error).toContain("authorization needs to be reconnected");
    expect(client.status.error).not.toContain("access-token");
  });

  it("handles authorization revocation and non-authorization subscription removal distinctly", async () => {
    const lost = setup();
    lost.client.start();
    lost.sockets[0]?.sendMessage({
      metadata: { message_id: "revoke-auth", message_type: "revocation" },
      payload: { subscription: { type: "channel.chat.message", status: "authorization_revoked" } },
    });
    await flush();
    expect(lost.onAuthorizationLost).toHaveBeenCalledTimes(1);
    expect(lost.client.status.subscription).toBe("revoked");

    const removed = setup();
    removed.client.start();
    removed.sockets[0]?.sendMessage({
      metadata: { message_id: "revoke-version", message_type: "revocation" },
      payload: { subscription: { type: "channel.chat.message", status: "version_removed" } },
    });
    await flush();
    expect(removed.onAuthorizationLost).not.toHaveBeenCalled();
    expect(removed.client.status.error).toContain("removed the chat subscription");
    lost.client.stop();
    removed.client.stop();
  });

  it("closes sockets and timers when stopped", async () => {
    vi.useFakeTimers();
    const { client, sockets } = setup();
    client.start();
    sockets[0]?.sendMessage(welcome("session-1"));
    await flush();
    client.stop();
    expect(sockets[0]?.closed).toBe(true);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(sockets).toHaveLength(1);
    expect(client.status.connection).toBe("stopped");
  });
});
