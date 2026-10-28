import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

const phase = v.union(
  v.literal("idle"), v.literal("suggestions"), v.literal("review"), v.literal("voting"),
  v.literal("active"), v.literal("paused"), v.literal("succeeded"), v.literal("expired"), v.literal("cancelled"),
);

const challengeState = v.object({
  revision: v.number(),
  phase,
  config: v.union(v.null(), v.object({
    suggestionDurationMs: v.number(), votingDurationMs: v.number(), challengeDurationMs: v.number(),
    chargeGoal: v.number(), chargePerMessage: v.number(),
  })),
  phaseEndsAt: v.union(v.null(), v.number()),
  pausedFrom: v.union(v.null(), v.literal("idle"), v.literal("suggestions"), v.literal("review"), v.literal("voting"), v.literal("active"), v.literal("succeeded"), v.literal("expired"), v.literal("cancelled")),
  pausedRemainingMs: v.union(v.null(), v.number()),
  suggestions: v.array(v.object({ id: v.string(), userId: v.string(), text: v.string(), normalizedText: v.string(), submittedAt: v.number() })),
  candidates: v.array(v.object({ id: v.string(), label: v.union(v.literal("A"), v.literal("B"), v.literal("C")), text: v.string(), suggestionId: v.string() })),
  votes: v.record(v.string(), v.string()),
  contributionCount: v.number(),
  charge: v.number(),
  winningCandidateId: v.union(v.null(), v.string()),
  lastChargeAtByUser: v.record(v.string(), v.number()),
  suggestionIdByUser: v.record(v.string(), v.string()),
  suggestionMetadata: v.record(v.string(), v.object({ source: v.union(v.literal("live"), v.literal("simulated")), actor: v.string() })),
});

const twitchState = v.object({
  connection: v.union(v.literal("stopped"), v.literal("connecting"), v.literal("connected"), v.literal("error")),
  subscription: v.union(v.literal("none"), v.literal("pending"), v.literal("enabled"), v.literal("revoked"), v.literal("error")),
  error: v.union(v.null(), v.string()),
  broadcaster: v.union(v.null(), v.object({ id: v.string(), login: v.string(), displayName: v.string() })),
  chatReader: v.union(v.null(), v.object({ id: v.string(), login: v.string(), displayName: v.string() })),
  lastMessageAt: v.union(v.null(), v.number()),
  messagesReceived: v.number(),
});

export default defineSchema({
  challenge: defineTable({
    key: v.literal("primary"),
    state: challengeState,
    source: v.union(v.null(), v.literal("live"), v.literal("simulated")),
    twitch: twitchState,
    simulatedMessagesReceived: v.number(),
  }).index("by_key", ["key"]),
  activity: defineTable({
    eventId: v.string(),
    source: v.union(v.literal("live"), v.literal("simulated")),
    actor: v.string(),
    command: v.string(),
    outcome: v.string(),
    detail: v.union(v.null(), v.string()),
    at: v.number(),
  }).index("by_eventId", ["eventId"]).index("by_at", ["at"]),
  viewerStats: defineTable({
    userId: v.string(),
    displayName: v.string(),
    totalCharges: v.number(),
    totalContributions: v.number(),
    updatedAt: v.number(),
  }).index("by_userId", ["userId"]).index("by_totalCharges_and_userId", ["totalCharges", "userId"]),
  processedEvents: defineTable({
    eventId: v.string(),
    chatMessageId: v.string(),
    receivedAt: v.number(),
  }).index("by_eventId", ["eventId"]).index("by_chatMessageId", ["chatMessageId"]).index("by_receivedAt", ["receivedAt"]),
  credentials: defineTable({
    key: v.string(),
    role: v.union(v.literal("broadcaster"), v.literal("chatReader")),
    identity: v.object({ id: v.string(), login: v.string(), displayName: v.string() }),
    encryptedTokens: v.string(),
    scopes: v.array(v.string()),
    updatedAt: v.number(),
  }).index("by_key", ["key"]),
});
