import { convexTest, type TestConvex } from "convex-test";
import { describe, expect, it } from "vitest";
import { internal, api } from "./_generated/api.js";
import schema from "./schema.js";

const modules = import.meta.glob(["./state.ts", "./_generated/*.ts"]);
type TestContext = TestConvex<typeof schema>;
const identities = {
  broadcaster: { id: "broadcaster-1", login: "host", displayName: "Host" },
  chatReader: { id: "reader-1", login: "chatreader", displayName: "Chat Reader" },
};
const config = {
  suggestionDurationMs: 5_000,
  votingDurationMs: 5_000,
  challengeDurationMs: 10_000,
  chargeGoal: 1,
  chargePerMessage: 1,
};

async function installCredentials(t: TestContext) {
  await t.mutation(internal.state.storeCredential, {
    key: "broadcaster", role: "broadcaster", identity: identities.broadcaster,
    encryptedTokens: "encrypted-test-token", scopes: ["channel:bot"], updatedAt: Date.now(),
  });
  await t.mutation(internal.state.storeCredential, {
    key: "chatReader", role: "chatReader", identity: identities.chatReader,
    encryptedTokens: "encrypted-test-token", scopes: ["user:read:chat", "user:bot"], updatedAt: Date.now(),
  });
}

async function deliver(t: TestContext, eventId: string, chatMessageId: string, text: string, userId = "viewer-1", displayName = "Viewer") {
  return await t.mutation(internal.state.applyChatEvent, {
    eventId,
    chatMessageId,
    broadcasterId: identities.broadcaster.id,
    chatReaderId: identities.chatReader.id,
    userId,
    displayName,
    text,
    at: Date.now(),
  });
}

async function forceDeadlinePast(t: TestContext) {
  await t.run(async (ctx) => {
    const record = await ctx.db.query("challenge").withIndex("by_key", (q) => q.eq("key", "primary")).unique();
    if (!record?.state.phaseEndsAt) throw new Error("Expected a timed challenge phase.");
    const deadline = Date.now() - 1;
    await ctx.db.patch(record._id, { state: { ...record.state, phaseEndsAt: deadline } });
  });
  const state = await t.query(api.state.publicState, {});
  const deadline = state.challenge.phaseEndsAt;
  if (deadline === null) throw new Error("Expected the challenge deadline to remain present.");
  await t.mutation(internal.state.advanceAtDeadline, { deadline });
}

describe("Convex authoritative challenge state", () => {
  it("returns an empty leaderboard on a fresh deployment", async () => {
    const t = convexTest(schema, modules);
    expect(await t.query(api.state.publicLeaderboard, {})).toEqual([]);
  });

  it("rejects unauthenticated streamer actions and invalid transitions", async () => {
    const t = convexTest(schema, modules);
    const unauthenticated = await t.mutation(internal.state.applyAction, {
      streamerId: "attacker", action: { type: "start-round", config },
    });
    expect(unauthenticated).toMatchObject({ accepted: false, error: "unauthorized" });

    await installCredentials(t);
    const started = await t.mutation(internal.state.applyAction, {
      streamerId: identities.broadcaster.id, action: { type: "start-round", config },
    });
    expect(started.accepted).toBe(true);
    const repeatedStart = await t.mutation(internal.state.applyAction, {
      streamerId: identities.broadcaster.id, action: { type: "start-round", config },
    });
    expect(repeatedStart).toMatchObject({ accepted: false, error: "invalid-phase" });
  });

  it("uses scheduled server deadlines and applies duplicate chat deliveries only once", async () => {
    const t = convexTest(schema, modules);
    await installCredentials(t);
    await t.mutation(internal.state.applyAction, {
      streamerId: identities.broadcaster.id, action: { type: "start-round", config },
    });

    expect(await deliver(t, "notification-1", "chat-1", "!suggest No jumping")).toMatchObject({ accepted: true });
    const duplicateNotification = await deliver(t, "notification-1", "chat-other", "!suggest Another idea");
    const duplicateChatMessage = await deliver(t, "notification-other", "chat-1", "!suggest Another idea");
    expect(duplicateNotification).toMatchObject({ accepted: false, reason: "duplicate" });
    expect(duplicateChatMessage).toMatchObject({ accepted: false, reason: "duplicate" });

    await forceDeadlinePast(t);
    const review = await t.query(api.state.publicState, {});
    expect(review.challenge.phase).toBe("review");
    const suggestionId = review.challenge.suggestions[0]?.id;
    if (!suggestionId) throw new Error("Suggestion should be persisted before approval.");
    await t.mutation(internal.state.applyAction, {
      streamerId: identities.broadcaster.id, action: { type: "approve-candidates", suggestionIds: [suggestionId] },
    });
    await forceDeadlinePast(t);
    expect((await t.query(api.state.publicState, {})).challenge.phase).toBe("active");

    expect(await deliver(t, "notification-charge", "chat-charge", "!charge")).toMatchObject({ accepted: true });
    expect(await deliver(t, "notification-charge-retry", "chat-charge", "!charge")).toMatchObject({ accepted: false, reason: "duplicate" });
    const finalState = await t.query(api.state.publicState, {});
    expect(finalState.challenge).toMatchObject({ phase: "succeeded", charge: 1, contributionCount: 1 });
    expect(finalState.chat.messagesReceived).toBe(2);
  });

  it("exposes sanitized public snapshots while keeping credentials and voter identity internal", async () => {
    const t = convexTest(schema, modules);
    await installCredentials(t);
    const snapshot = await t.query(api.state.publicState, {});
    const serialized = JSON.stringify(snapshot);
    expect(serialized).not.toContain("encrypted-test-token");
    expect(serialized).not.toContain("broadcaster-1");
    expect(serialized).not.toContain("reader-1");
    expect(snapshot).not.toHaveProperty("credentials");

    const status = await t.query(api.state.publicStatus, {});
    expect(JSON.stringify(status)).not.toContain("broadcaster-1");
    expect(JSON.stringify(status)).not.toContain("reader-1");

    const overlay = await t.query(api.state.publicOverlayState, {});
    expect(overlay).not.toHaveProperty("activity");
    expect(overlay).not.toHaveProperty("chat");
    expect(overlay).not.toHaveProperty("suggestionMetadata");
    expect(JSON.stringify(overlay)).not.toContain("host");
    expect(JSON.stringify(overlay)).not.toContain("reader-1");
  });

  it("accumulates only accepted live charges and ignores rejected and deduplicated commands", async () => {
    const t = convexTest(schema, modules);
    await installCredentials(t);
    await t.mutation(internal.state.applyAction, {
      streamerId: identities.broadcaster.id,
      action: { type: "start-round", config: { ...config, chargeGoal: 4, chargePerMessage: 2 } },
    });
    expect(await deliver(t, "charge-before-active", "chat-before-active", "!charge", "viewer-1", "Unaccepted Name"))
      .toMatchObject({ accepted: false, reason: "invalid-phase" });
    expect(await t.query(api.state.publicLeaderboard, {})).toEqual([]);

    expect(await deliver(t, "suggestion", "chat-suggestion", "!suggest No jumping", "suggestor", "Idea Maker"))
      .toMatchObject({ accepted: true });
    await forceDeadlinePast(t);
    const review = await t.query(api.state.publicState, {});
    const suggestionId = review.challenge.suggestions[0]?.id;
    if (!suggestionId) throw new Error("Suggestion should be persisted before approval.");
    await t.mutation(internal.state.applyAction, {
      streamerId: identities.broadcaster.id, action: { type: "approve-candidates", suggestionIds: [suggestionId] },
    });
    await forceDeadlinePast(t);

    expect(await deliver(t, "charge-1", "chat-charge-1", "!charge", "viewer-1", "First Name"))
      .toMatchObject({ accepted: true });
    expect(await deliver(t, "charge-1", "chat-retry", "!charge", "viewer-1", "Duplicate Name"))
      .toMatchObject({ accepted: false, reason: "duplicate" });
    expect(await deliver(t, "vote-in-active", "chat-rejected", "!vote A", "viewer-1", "Rejected Name"))
      .toMatchObject({ accepted: false, reason: "invalid-phase" });

    await new Promise((resolve) => setTimeout(resolve, 1_010));
    expect(await deliver(t, "charge-2", "chat-charge-2", "!charge", "viewer-1", "Updated Name"))
      .toMatchObject({ accepted: true });
    const leaderboard = await t.query(api.state.publicLeaderboard, {});
    expect(leaderboard).toEqual([{ displayName: "Updated Name", totalCharges: 4, totalContributions: 2 }]);
    expect(Object.keys(leaderboard[0] ?? {}).sort()).toEqual(["displayName", "totalCharges", "totalContributions"]);
    expect(JSON.stringify(leaderboard)).not.toContain("viewer-1");
  });

  it("returns only the top five with deterministic ordering for equal charge totals", async () => {
    const t = convexTest(schema, modules);
    await t.run(async (ctx) => {
      const seeded = [
        { userId: "viewer-a", displayName: "Alpha", totalCharges: 10, totalContributions: 3, updatedAt: 10 },
        { userId: "viewer-z", displayName: "Zulu", totalCharges: 10, totalContributions: 4, updatedAt: 10 },
        { userId: "viewer-b", displayName: "Bravo", totalCharges: 7, totalContributions: 2, updatedAt: 10 },
        { userId: "viewer-y", displayName: "Yankee", totalCharges: 7, totalContributions: 3, updatedAt: 10 },
        { userId: "viewer-m", displayName: "Mike", totalCharges: 6, totalContributions: 2, updatedAt: 10 },
        { userId: "viewer-x", displayName: "Xray", totalCharges: 2, totalContributions: 1, updatedAt: 10 },
      ];
      for (const viewer of seeded) await ctx.db.insert("viewerStats", viewer);
    });

    const first = await t.query(api.state.publicLeaderboard, {});
    const second = await t.query(api.state.publicLeaderboard, {});
    expect(first.map((viewer) => viewer.displayName)).toEqual(["Zulu", "Alpha", "Yankee", "Bravo", "Mike"]);
    expect(second).toEqual(first);
    expect(first).toHaveLength(5);
    expect(JSON.stringify(first)).not.toContain("viewer-");
    expect(first.every((viewer) => Object.keys(viewer).sort().join(",") === "displayName,totalCharges,totalContributions")).toBe(true);
  });
});
