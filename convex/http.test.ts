import { convexTest } from "convex-test";
import { afterEach, describe, expect, it } from "vitest";
import { internal } from "./_generated/api.js";
import schema from "./schema.js";

const modules = import.meta.glob(["./state.ts", "./http.ts", "./_generated/*.ts"]);
const secret = "eventsub-test-secret-long-enough";
const broadcaster = { id: "broadcaster-1", login: "host", displayName: "Host" };
const chatReader = { id: "reader-1", login: "chatreader", displayName: "Chat Reader" };
const encoder = new TextEncoder();

afterEach(() => {
  delete process.env.TWITCH_EVENTSUB_SECRET;
});

async function signature(messageId: string, timestamp: string, body: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const bytes = new Uint8Array(await crypto.subtle.sign("HMAC", key, encoder.encode(messageId + timestamp + body)));
  return `sha256=${Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

async function setup() {
  process.env.TWITCH_EVENTSUB_SECRET = secret;
  const t = convexTest(schema, modules);
  await t.mutation(internal.state.storeCredential, {
    key: "broadcaster", role: "broadcaster", identity: broadcaster,
    encryptedTokens: "encrypted", scopes: ["channel:bot"], updatedAt: Date.now(),
  });
  await t.mutation(internal.state.storeCredential, {
    key: "chatReader", role: "chatReader", identity: chatReader,
    encryptedTokens: "encrypted", scopes: ["user:read:chat", "user:bot"], updatedAt: Date.now(),
  });
  return t;
}

function callbackBody(challenge: string): string {
  return JSON.stringify({
    challenge,
    subscription: {
      type: "channel.chat.message",
      version: "1",
      condition: { broadcaster_user_id: broadcaster.id, user_id: chatReader.id },
    },
  });
}

describe("Convex EventSub webhook route", () => {
  it("returns the raw Twitch challenge only after verifying the signed callback", async () => {
    const t = await setup();
    const body = callbackBody("verification-proof");
    const messageId = "verification-1";
    const timestamp = new Date().toISOString();
    const response = await t.fetch("/twitch/eventsub", {
      method: "POST",
      headers: {
        "Twitch-Eventsub-Message-Type": "webhook_callback_verification",
        "Twitch-Eventsub-Message-Id": messageId,
        "Twitch-Eventsub-Message-Timestamp": timestamp,
        "Twitch-Eventsub-Message-Signature": await signature(messageId, timestamp, body),
      },
      body,
    });

    expect(response.status).toBe(200);
    expect(await response.text()).toBe("verification-proof");
    expect(response.headers.get("content-type")).toContain("text/plain");
  });

  it("rejects malformed JSON, forged signatures, stale retries, and mismatched subscription identities", async () => {
    const t = await setup();
    const validBody = callbackBody("proof");
    const messageId = "invalid-1";
    const fresh = new Date().toISOString();
    const forged = await t.fetch("/twitch/eventsub", {
      method: "POST",
      headers: {
        "Twitch-Eventsub-Message-Type": "webhook_callback_verification",
        "Twitch-Eventsub-Message-Id": messageId,
        "Twitch-Eventsub-Message-Timestamp": fresh,
        "Twitch-Eventsub-Message-Signature": `sha256=${"0".repeat(64)}`,
      },
      body: validBody,
    });
    expect(forged.status).toBe(403);

    const malformedBody = "{";
    const malformedId = "malformed-1";
    const malformed = await t.fetch("/twitch/eventsub", {
      method: "POST",
      headers: {
        "Twitch-Eventsub-Message-Type": "webhook_callback_verification",
        "Twitch-Eventsub-Message-Id": malformedId,
        "Twitch-Eventsub-Message-Timestamp": fresh,
        "Twitch-Eventsub-Message-Signature": await signature(malformedId, fresh, malformedBody),
      },
      body: malformedBody,
    });
    expect(malformed.status).toBe(400);

    const staleTimestamp = new Date(Date.now() - 11 * 60_000).toISOString();
    const stale = await t.fetch("/twitch/eventsub", {
      method: "POST",
      headers: {
        "Twitch-Eventsub-Message-Type": "webhook_callback_verification",
        "Twitch-Eventsub-Message-Id": "stale-1",
        "Twitch-Eventsub-Message-Timestamp": staleTimestamp,
        "Twitch-Eventsub-Message-Signature": await signature("stale-1", staleTimestamp, validBody),
      },
      body: validBody,
    });
    expect(stale.status).toBe(403);

    const mismatchedBody = JSON.stringify({
      challenge: "proof",
      subscription: { type: "channel.chat.message", version: "1", condition: { broadcaster_user_id: "other", user_id: chatReader.id } },
    });
    const mismatched = await t.fetch("/twitch/eventsub", {
      method: "POST",
      headers: {
        "Twitch-Eventsub-Message-Type": "webhook_callback_verification",
        "Twitch-Eventsub-Message-Id": "mismatch-1",
        "Twitch-Eventsub-Message-Timestamp": fresh,
        "Twitch-Eventsub-Message-Signature": await signature("mismatch-1", fresh, mismatchedBody),
      },
      body: mismatchedBody,
    });
    expect(mismatched.status).toBe(403);
  });
});
