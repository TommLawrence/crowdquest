import { describe, expect, it } from "vitest";
import {
  applyStreamerAction,
  createInitialState,
  type ChallengeConfig,
  type ChallengeState,
} from "../src/domain/challenge.js";
import { normalizeChatNotification } from "./chat-message.js";
import { ChatRuntime } from "./chat-runtime.js";

const config: ChallengeConfig = {
  suggestionDurationMs: 10_000,
  votingDurationMs: 5_000,
  challengeDurationMs: 20_000,
  chargeGoal: 2,
  chargePerMessage: 1,
};

function event(overrides: Record<string, unknown> = {}) {
  return {
    metadata: {
      message_id: "notification-1",
      message_type: "notification",
      subscription_type: "channel.chat.message",
      message_timestamp: "2026-10-27T12:00:00.123Z",
    },
    payload: {
      subscription: {
        type: "channel.chat.message",
        version: "1",
        condition: { broadcaster_user_id: "streamer-id", user_id: "streamer-id" },
      },
      event: {
        broadcaster_user_id: "streamer-id",
        chatter_user_id: "viewer-id",
        chatter_user_login: "viewer",
        chatter_user_name: "Viewer",
        message_id: "chat-message-1",
        message: { text: "!suggest No jumping" },
      },
    },
    ...overrides,
  };
}

describe("EventSub chat normalization and command dispatch", () => {
  it("normalizes stable Twitch IDs, display names, text, and event timestamp", () => {
    expect(normalizeChatNotification(event(), "streamer-id", 99)).toEqual({
      notificationId: "notification-1",
      messageId: "chat-message-1",
      broadcasterId: "streamer-id",
      userId: "viewer-id",
      login: "viewer",
      displayName: "Viewer",
      text: "!suggest No jumping",
      timestamp: Date.parse("2026-10-27T12:00:00.123Z"),
    });
  });

  it("rejects malformed and wrong-channel events", () => {
    expect(normalizeChatNotification(null, "streamer-id")).toBeNull();
    expect(normalizeChatNotification(event({ metadata: {} }), "streamer-id")).toBeNull();
    expect(normalizeChatNotification(event(), "someone-else")).toBeNull();
    const malformed = event();
    (malformed.payload.event as Record<string, unknown>).message = { text: "x".repeat(501) };
    expect(normalizeChatNotification(malformed, "streamer-id")).toBeNull();
  });

  it("routes accepted and phase-rejected commands through the existing challenge engine", () => {
    let state: ChallengeState = createInitialState();
    const started = applyStreamerAction(state, { streamerId: "streamer-id" }, { type: "start-round", config }, 1_000);
    if (!started.accepted) throw new Error("Test round did not start.");
    state = started.state;
    const runtime = new ChatRuntime(() => state, (next) => { state = next; }, () => 1_500);
    const normalized = normalizeChatNotification(event(), "streamer-id");
    if (!normalized) throw new Error("Test fixture did not normalize.");

    runtime.receive(normalized);
    expect(state.suggestions).toHaveLength(1);
    expect(state.suggestions[0]).toMatchObject({ userId: "viewer-id", text: "No jumping" });
    expect(runtime.snapshot()).toMatchObject({
      messagesReceived: 1,
      latestCommand: { name: "suggest", outcome: "accepted" },
    });

    const secondMessage = { ...normalized, messageId: "chat-message-2", text: "!charge", timestamp: normalized.timestamp + 1 };
    runtime.receive(secondMessage);
    expect(state.phase).toBe("suggestions");
    expect(runtime.snapshot().latestCommand).toMatchObject({ name: "charge", outcome: "invalid-phase" });
  });
});
