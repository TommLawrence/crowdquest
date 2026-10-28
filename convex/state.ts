import { internalMutation, internalQuery, query } from "./_generated/server";
import { v } from "convex/values";
import { internal } from "./_generated/api";
import type { MutationCtx } from "./_generated/server.js";
import {
  advanceTime,
  applyChatCommand,
  applyStreamerAction,
  createInitialState,
  parseChatCommand,
  type StreamerAction,
} from "../src/domain/challenge.js";

const EMPTY_TWITCH = {
  connection: "stopped" as const,
  subscription: "none" as const,
  error: null,
  broadcaster: null,
  chatReader: null,
  lastMessageAt: null,
  messagesReceived: 0,
};

const actionValidator = v.union(
  v.object({ type: v.literal("start-round"), config: v.object({
    suggestionDurationMs: v.number(), votingDurationMs: v.number(), challengeDurationMs: v.number(),
    chargeGoal: v.number(), chargePerMessage: v.number(),
  }) }),
  v.object({ type: v.literal("approve-candidates"), suggestionIds: v.array(v.string()) }),
  v.object({ type: v.literal("pause") }), v.object({ type: v.literal("resume") }),
  v.object({ type: v.literal("cancel") }), v.object({ type: v.literal("reset") }),
);

type StoredChallengeState = ReturnType<typeof createInitialState> & {
  suggestionMetadata: Record<string, { source: "live" | "simulated"; actor: string }>;
};

export const publicState = query({
  args: {},
  handler: async (ctx) => {
    const record = await ctx.db.query("challenge").withIndex("by_key", (q) => q.eq("key", "primary")).unique();
    const activity = await ctx.db.query("activity").withIndex("by_at").order("desc").take(24);
    const state = (record?.state as StoredChallengeState | undefined) ?? { ...createInitialState(), suggestionMetadata: {} };
    const voteCounts: Record<string, number> = Object.fromEntries(state.candidates.map((candidate) => [candidate.id, 0]));
    for (const candidateId of Object.values(state.votes)) {
      if (candidateId in voteCounts) voteCounts[candidateId] = (voteCounts[candidateId] ?? 0) + 1;
    }
    const latest = activity[0];
    return {
      challenge: {
        revision: state.revision,
        phase: state.phase,
        config: state.config,
        phaseEndsAt: state.phaseEndsAt,
        pausedFrom: state.pausedFrom,
        pausedRemainingMs: state.pausedRemainingMs,
        suggestions: state.suggestions.map(({ id, text, submittedAt }) => ({ id, text, submittedAt })),
        candidates: state.candidates,
        voteCounts,
        contributionCount: state.contributionCount,
        charge: state.charge,
        winningCandidateId: state.winningCandidateId,
      },
      challengeSource: record?.source ?? null,
      suggestionMetadata: state.suggestionMetadata,
      activity: activity.map(({ eventId, source, actor, command, outcome, detail, at }) => ({ id: eventId, source, actor, command, outcome, detail, at })),
      chat: {
        messagesReceived: record?.twitch.messagesReceived ?? 0,
        simulatedMessagesReceived: record?.simulatedMessagesReceived ?? 0,
        lastMessageAt: record?.twitch.lastMessageAt ?? null,
        latestCommand: latest ? { name: latest.command, outcome: latest.outcome, at: latest.at, source: latest.source } : null,
      },
      twitch: {
        configured: Boolean(record?.twitch.broadcaster),
        connected: record?.twitch.connection === "connected",
        connection: record?.twitch.connection ?? "stopped",
        subscription: record?.twitch.subscription ?? "none",
        reconnectAttempts: 0,
        error: record?.twitch.error ?? null,
        broadcaster: record?.twitch.broadcaster ? {
          login: record.twitch.broadcaster.login,
          displayName: record.twitch.broadcaster.displayName,
        } : null,
        chatReader: record?.twitch.chatReader ? {
          login: record.twitch.chatReader.login,
          displayName: record.twitch.chatReader.displayName,
        } : null,
      },
      simulatedChatEnabled: false,
    };
  },
});

export const publicStatus = query({
  args: {},
  handler: async (ctx) => {
    const record = await ctx.db.query("challenge").withIndex("by_key", (q) => q.eq("key", "primary")).unique();
    return {
      configured: Boolean(record?.twitch.broadcaster),
      authorized: Boolean(record?.twitch.broadcaster),
      broadcaster: record?.twitch.broadcaster ? {
        login: record.twitch.broadcaster.login,
        displayName: record.twitch.broadcaster.displayName,
      } : null,
      chatReader: record?.twitch.chatReader ? {
        login: record.twitch.chatReader.login,
        displayName: record.twitch.chatReader.displayName,
      } : null,
      eventSub: {
        connection: record?.twitch.connection ?? "stopped",
        subscription: record?.twitch.subscription ?? "none",
        reconnectAttempts: 0,
        error: record?.twitch.error ?? null,
      },
      messagesReceived: record?.twitch.messagesReceived ?? 0,
      lastMessageAt: record?.twitch.lastMessageAt ?? null,
    };
  },
});

export const publicOverlayState = query({
  args: {},
  handler: async (ctx) => {
    const record = await ctx.db.query("challenge").withIndex("by_key", (q) => q.eq("key", "primary")).unique();
    const state = (record?.state as StoredChallengeState | undefined) ?? { ...createInitialState(), suggestionMetadata: {} };
    const voteCounts: Record<string, number> = Object.fromEntries(state.candidates.map((candidate) => [candidate.id, 0]));
    for (const candidateId of Object.values(state.votes)) {
      if (candidateId in voteCounts) voteCounts[candidateId] = (voteCounts[candidateId] ?? 0) + 1;
    }
    return {
      challenge: {
        revision: state.revision,
        phase: state.phase,
        config: state.config,
        phaseEndsAt: state.phaseEndsAt,
        pausedRemainingMs: state.pausedRemainingMs,
        candidates: state.candidates.map(({ id, label, text }) => ({ id, label, text })),
        voteCounts,
        contributionCount: state.contributionCount,
        charge: state.charge,
        winningCandidateId: state.winningCandidateId,
      },
      challengeSource: record?.source ?? null,
      twitch: {
        connection: record?.twitch.connection ?? "stopped",
        subscription: record?.twitch.subscription ?? "none",
      },
    };
  },
});

export const getCredential = internalQuery({
  args: { key: v.string() },
  handler: async (ctx, { key }) => {
    const credential = await ctx.db.query("credentials").withIndex("by_key", (q) => q.eq("key", key)).unique();
    return credential ? {
      role: credential.role,
      identity: credential.identity,
      encryptedTokens: credential.encryptedTokens,
      scopes: credential.scopes,
    } : null;
  },
});

export const getTwitchIdentities = internalQuery({
  args: {},
  handler: async (ctx) => {
    const broadcaster = await ctx.db.query("credentials").withIndex("by_key", (q) => q.eq("key", "broadcaster")).unique();
    const chatReader = await ctx.db.query("credentials").withIndex("by_key", (q) => q.eq("key", "chatReader")).unique();
    return { broadcaster: broadcaster?.identity ?? null, chatReader: chatReader?.identity ?? null };
  },
});

export const storeCredential = internalMutation({
  args: {
    key: v.string(),
    role: v.union(v.literal("broadcaster"), v.literal("chatReader")),
    identity: v.object({ id: v.string(), login: v.string(), displayName: v.string() }),
    encryptedTokens: v.string(),
    scopes: v.array(v.string()),
    updatedAt: v.number(),
  },
  handler: async (ctx, args) => {
    const current = await ctx.db.query("credentials").withIndex("by_key", (q) => q.eq("key", args.key)).unique();
    if (current) await ctx.db.patch(current._id, args);
    else await ctx.db.insert("credentials", args);
    if (args.role === "broadcaster") {
      await upsertChallenge(ctx, (record) => ({ ...record, twitch: { ...record.twitch, broadcaster: args.identity, connection: "connecting", subscription: "pending", error: null } }));
    } else {
      await upsertChallenge(ctx, (record) => ({ ...record, twitch: { ...record.twitch, chatReader: args.identity, connection: "connecting", subscription: "pending", error: null } }));
    }
  },
});

export const clearCredential = internalMutation({
  args: { key: v.string(), role: v.union(v.literal("broadcaster"), v.literal("chatReader")) },
  handler: async (ctx, { key, role }) => {
    const current = await ctx.db.query("credentials").withIndex("by_key", (q) => q.eq("key", key)).unique();
    if (current) await ctx.db.delete(current._id);
    if (role === "broadcaster") {
      await upsertChallenge(ctx, (record) => ({ ...record, twitch: { ...record.twitch, broadcaster: null, connection: "stopped", subscription: "none", error: null } }));
    } else {
      await upsertChallenge(ctx, (record) => ({ ...record, twitch: { ...record.twitch, chatReader: null, connection: "stopped", subscription: "none", error: null } }));
    }
  },
});

export const setTwitchStatus = internalMutation({
  args: {
    connection: v.union(v.literal("stopped"), v.literal("connecting"), v.literal("connected"), v.literal("error")),
    subscription: v.union(v.literal("none"), v.literal("pending"), v.literal("enabled"), v.literal("revoked"), v.literal("error")),
    error: v.union(v.null(), v.string()),
  },
  handler: async (ctx, { connection, subscription, error }) => {
    await upsertChallenge(ctx, (record) => ({ ...record, twitch: { ...record.twitch, connection, subscription, error } }));
  },
});

export const applyAction = internalMutation({
  args: { streamerId: v.string(), action: actionValidator },
  handler: async (ctx, { streamerId, action }) => {
    const record = await getOrCreateChallenge(ctx);
    const broadcaster = await ctx.db.query("credentials").withIndex("by_key", (q) => q.eq("key", "broadcaster")).unique();
    if (!broadcaster || broadcaster.identity.id !== streamerId || broadcaster.role !== "broadcaster") {
      return { accepted: false, error: "unauthorized", revision: record.state.revision };
    }
    const now = Date.now();
    const persistedState = record.state as StoredChallengeState;
    const advanced = advanceTime(persistedState, now);
    const timeAdvanced = advanced.state !== persistedState;
    const base = { ...advanced.state, suggestionMetadata: persistedState.suggestionMetadata } as StoredChallengeState;
    const principal = { streamerId };
    const result = applyStreamerAction(base, principal, action as StreamerAction, now);
    if (!result.accepted) {
      if (timeAdvanced) {
        await ctx.db.patch(record._id, { state: base });
        await scheduleDeadline(ctx, base.phaseEndsAt);
      }
      return { accepted: false, error: result.error, revision: base.revision };
    }
    const source = action.type === "start-round" ? "live" : action.type === "reset" ? null : record.source;
    const nextState = { ...result.state, suggestionMetadata: action.type === "start-round" || action.type === "reset" ? {} : persistedState.suggestionMetadata };
    await ctx.db.patch(record._id, { state: nextState, source });
    await scheduleDeadline(ctx, nextState.phaseEndsAt);
    return { accepted: true, revision: nextState.revision };
  },
});

export const advanceAtDeadline = internalMutation({
  args: { deadline: v.number() },
  handler: async (ctx, { deadline }) => {
    const record = await ctx.db.query("challenge").withIndex("by_key", (q) => q.eq("key", "primary")).unique();
    if (!record || record.state.phaseEndsAt !== deadline) return { advanced: false };
    const now = Date.now();
    if (now < deadline) {
      await scheduleDeadline(ctx, deadline);
      return { advanced: false };
    }
    const persistedState = record.state as StoredChallengeState;
    const result = advanceTime(persistedState, now);
    if (result.state === record.state) return { advanced: false };
    const nextState = { ...result.state, suggestionMetadata: persistedState.suggestionMetadata };
    await ctx.db.patch(record._id, { state: nextState });
    await scheduleDeadline(ctx, nextState.phaseEndsAt);
    return { advanced: true, phase: nextState.phase };
  },
});

export const applyChatEvent = internalMutation({
  args: {
    eventId: v.string(), chatMessageId: v.string(), broadcasterId: v.string(), chatReaderId: v.string(),
    userId: v.string(), displayName: v.string(), text: v.string(), at: v.number(),
  },
  handler: async (ctx, args) => {
    const parsed = parseChatCommand(args.text);
    if (parsed.kind === "ignore") return { accepted: false, reason: "ignored" as const };
    const duplicateNotification = await ctx.db.query("processedEvents").withIndex("by_eventId", (q) => q.eq("eventId", args.eventId)).unique();
    const duplicateMessage = await ctx.db.query("processedEvents").withIndex("by_chatMessageId", (q) => q.eq("chatMessageId", args.chatMessageId)).unique();
    if (duplicateNotification || duplicateMessage) return { accepted: false, reason: "duplicate" as const };

    const record = await getOrCreateChallenge(ctx);
    if (record.twitch.broadcaster?.id !== args.broadcasterId || record.twitch.chatReader?.id !== args.chatReaderId) {
      return { accepted: false, reason: "subscription-identity-mismatch" as const };
    }
    const now = Date.now();
    const persistedState = record.state as StoredChallengeState;
    const advanced = advanceTime(persistedState, now);
    let nextState = { ...advanced.state, suggestionMetadata: persistedState.suggestionMetadata } as StoredChallengeState;
    let command = "invalid";
    let outcome = "ignored";
    let detail: string | null = null;
    if (parsed.kind === "invalid") {
        command = /^\s*!(suggest|vote|charge)\b/i.exec(args.text)?.[1]?.toLowerCase() ?? "invalid";
        outcome = parsed.error;
      } else {
        command = parsed.command.type;
        const result = record.source && record.source !== "live"
          ? { accepted: false as const, state: nextState, error: "source-mismatch" }
          : applyChatCommand(nextState, args.userId, parsed.command, now);
        nextState = { ...result.state, suggestionMetadata: persistedState.suggestionMetadata };
        outcome = result.accepted ? "accepted" : result.error;
        if (result.accepted && parsed.command.type === "suggest") {
          const suggestion = nextState.suggestions.find((item) => item.userId === args.userId);
          if (suggestion) {
            nextState = { ...nextState, suggestionMetadata: { ...nextState.suggestionMetadata, [suggestion.id]: { source: "live", actor: args.displayName } } };
            detail = suggestion.text;
          }
        } else if (parsed.command.type === "vote") detail = parsed.command.label;
    }

    await ctx.db.insert("processedEvents", { eventId: args.eventId, chatMessageId: args.chatMessageId, receivedAt: now });
    await ctx.db.patch(record._id, {
      state: nextState,
      source: nextState.phase === "suggestions" && record.state.phase === "idle" ? "live" : record.source,
      twitch: { ...record.twitch, messagesReceived: record.twitch.messagesReceived + 1, lastMessageAt: args.at },
    });
    if (advanced.state !== record.state) await scheduleDeadline(ctx, nextState.phaseEndsAt);
    await ctx.db.insert("activity", { eventId: args.eventId, source: "live", actor: args.displayName.slice(0, 80), command, outcome, detail, at: args.at });
    const oldest = await ctx.db.query("activity").withIndex("by_at").order("asc").take(25);
    if (oldest.length > 24 && oldest[0]) await ctx.db.delete(oldest[0]._id);
    return { accepted: outcome === "accepted", reason: outcome };
  },
});

export const pruneProcessedEvents = internalMutation({
  args: {},
  handler: async (ctx) => {
    const cutoff = Date.now() - 7 * 24 * 60 * 60 * 1_000;
    const expired = await ctx.db.query("processedEvents").withIndex("by_receivedAt", (q) => q.lt("receivedAt", cutoff)).take(500);
    for (const event of expired) await ctx.db.delete(event._id);
    if (expired.length === 500) await ctx.scheduler.runAfter(0, internal.state.pruneProcessedEvents, {});
    return expired.length;
  },
});

async function getOrCreateChallenge(ctx: Pick<MutationCtx, "db">) {
  const current = await ctx.db.query("challenge").withIndex("by_key", (q) => q.eq("key", "primary")).unique();
  if (current) return current;
  const _id = await ctx.db.insert("challenge", {
    key: "primary",
    state: { ...createInitialState(), suggestionMetadata: {} },
    source: null,
    twitch: EMPTY_TWITCH,
    simulatedMessagesReceived: 0,
  });
  const inserted = await ctx.db.get(_id);
  if (!inserted) throw new Error("Could not initialize challenge state.");
  return inserted;
}

async function scheduleDeadline(ctx: Pick<MutationCtx, "scheduler">, deadline: number | null) {
  if (deadline !== null) await ctx.scheduler.runAt(deadline, internal.state.advanceAtDeadline, { deadline });
}

async function upsertChallenge(ctx: Pick<MutationCtx, "db">, update: (record: NonNullable<Awaited<ReturnType<typeof getOrCreateChallenge>>>) => object) {
  const record = await getOrCreateChallenge(ctx);
  await ctx.db.patch(record._id, update(record));
}
