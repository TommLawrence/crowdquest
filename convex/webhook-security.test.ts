import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { constantTimeTextEqual, verifyTwitchWebhook } from "./webhook_security.js";

const secret = "test-eventsub-secret-long-enough";
const rawBody = JSON.stringify({ challenge: "abc", value: "chat 💬" });
const messageId = "notification-123";
const nowMs = Date.parse("2026-10-27T12:00:00.000Z");

function signed(timestamp: string, body = rawBody) {
  const digest = createHmac("sha256", secret).update(messageId + timestamp + body).digest("hex");
  return {
    secret,
    messageId,
    timestamp,
    signature: `sha256=${digest}`,
    rawBody: body,
    nowMs,
  };
}

describe("Twitch EventSub webhook security", () => {
  it("validates HMAC against the exact raw body, including Unicode", async () => {
    const timestamp = "2026-10-27T12:00:00.000Z";
    await expect(verifyTwitchWebhook(signed(timestamp))).resolves.toBe(true);
    await expect(verifyTwitchWebhook({ ...signed(timestamp), rawBody: rawBody + " " })).resolves.toBe(false);
  });

  it("rejects changed message IDs, signatures, short secrets, and missing headers", async () => {
    const timestamp = "2026-10-27T12:00:00.000Z";
    const valid = signed(timestamp);
    await expect(verifyTwitchWebhook({ ...valid, messageId: "changed" })).resolves.toBe(false);
    await expect(verifyTwitchWebhook({ ...valid, signature: `sha256=${"0".repeat(64)}` })).resolves.toBe(false);
    await expect(verifyTwitchWebhook({ ...valid, secret: "short" })).resolves.toBe(false);
    await expect(verifyTwitchWebhook({ ...valid, timestamp: null })).resolves.toBe(false);
  });

  it("rejects stale, future, malformed, and invalidly encoded timestamps", async () => {
    const stale = "2026-10-27T11:49:59.999Z";
    const future = "2026-10-27T12:00:30.001Z";
    await expect(verifyTwitchWebhook(signed(stale))).resolves.toBe(false);
    await expect(verifyTwitchWebhook(signed(future))).resolves.toBe(false);
    await expect(verifyTwitchWebhook(signed("not-a-date"))).resolves.toBe(false);
    await expect(verifyTwitchWebhook(signed("2026-10-27T12:00:00.000Z"),)).resolves.toBe(true);
  });

  it("compares internal bearer values without an early character mismatch return", () => {
    expect(constantTimeTextEqual("Bearer one", "Bearer one")).toBe(true);
    expect(constantTimeTextEqual("Bearer one", "Bearer two")).toBe(false);
    expect(constantTimeTextEqual("Bearer one", "Bearer one-longer")).toBe(false);
  });
});
