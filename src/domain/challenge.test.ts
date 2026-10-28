import { describe, expect, it } from "vitest";
import {
  advanceTime,
  applyChatMessage,
  applyStreamerAction,
  createInitialState,
  parseChatCommand,
  type ChallengeConfig,
  type ChallengeState,
  type StreamerAction,
  type StreamerPrincipal,
} from "./challenge.js";

const streamer: StreamerPrincipal = { streamerId: "streamer-1" };
const config: ChallengeConfig = {
  suggestionDurationMs: 10_000,
  votingDurationMs: 5_000,
  challengeDurationMs: 20_000,
  chargeGoal: 3,
  chargePerMessage: 1,
};

function action(state: ChallengeState, command: StreamerAction, nowMs = 1_000): ChallengeState {
  const result = applyStreamerAction(state, streamer, command, nowMs);
  if (!result.accepted) throw new Error(`Unexpected transition rejection: ${result.error}`);
  return result.state;
}

function chat(state: ChallengeState, userId: string, text: string, nowMs: number) {
  return applyChatMessage(state, userId, text, nowMs);
}

function withVoting(): ChallengeState {
  let state = action(createInitialState(), { type: "start-round", config }, 1_000);
  state = chat(state, "viewer-1", "!suggest No jumping", 1_100).state;
  state = chat(state, "viewer-2", "!suggest Use only a wooden sword", 1_200).state;
  state = advanceTime(state, 11_000).state;
  const suggestionIds = state.suggestions.map((suggestion) => suggestion.id);
  return action(state, { type: "approve-candidates", suggestionIds }, 11_000);
}

describe("challenge state machine", () => {
  it("requires a server-authenticated streamer principal for controls", () => {
    const before = createInitialState();
    const result = applyStreamerAction(before, null, { type: "start-round", config }, 1_000);

    expect(result).toMatchObject({ accepted: false, error: "unauthorized" });
    expect(result.state).toBe(before);
  });

  it("validates round configuration and only starts from idle", () => {
    const initial = createInitialState();
    const invalidConfig = { ...config, chargeGoal: 0 };
    const badConfig = applyStreamerAction(initial, streamer, { type: "start-round", config: invalidConfig }, 1_000);
    expect(badConfig).toMatchObject({ accepted: false, error: "invalid-config" });

    const active = action(initial, { type: "start-round", config }, 1_000);
    const repeatedStart = applyStreamerAction(active, streamer, { type: "start-round", config }, 2_000);
    expect(repeatedStart).toMatchObject({ accepted: false, error: "invalid-phase" });
  });

  it("advances suggestions to review only when server time reaches the deadline", () => {
    const started = action(createInitialState(), { type: "start-round", config }, 1_000);
    expect(advanceTime(started, 10_999).state.phase).toBe("suggestions");

    const result = advanceTime(started, 11_000);
    expect(result.state.phase).toBe("review");
    expect(result.state.phaseEndsAt).toBeNull();
    expect(result.state.revision).toBe(started.revision + 1);
  });

  it("approves one to three submitted ideas and starts a timed vote", () => {
    const state = withVoting();
    expect(state.phase).toBe("voting");
    expect(state.candidates.map((candidate) => candidate.label)).toEqual(["A", "B"]);
    expect(state.phaseEndsAt).toBe(16_000);

    const invalid = applyStreamerAction(
      { ...state, phase: "review" },
      streamer,
      { type: "approve-candidates", suggestionIds: ["unknown"] },
      12_000,
    );
    expect(invalid).toMatchObject({ accepted: false, error: "invalid-candidates" });
  });

  it("selects the vote winner and resolves ties in approved candidate order", () => {
    let state = withVoting();
    state = chat(state, "voter-a", "!vote B", 12_000).state;
    state = chat(state, "voter-b", "!vote A", 12_100).state;
    state = advanceTime(state, 16_000).state;
    expect(state.phase).toBe("active");
    expect(state.winningCandidateId).toBe(state.candidates[0]?.id);
    expect(state.phaseEndsAt).toBe(36_000);

    let tied = withVoting();
    tied = advanceTime(tied, 16_000).state;
    expect(tied.winningCandidateId).toBe(tied.candidates[0]?.id);
  });

  it("pauses and resumes timed phases using server-calculated remaining time", () => {
    const started = action(createInitialState(), { type: "start-round", config }, 1_000);
    const paused = action(started, { type: "pause" }, 4_000);
    expect(paused).toMatchObject({ phase: "paused", pausedFrom: "suggestions", pausedRemainingMs: 7_000 });
    expect(advanceTime(paused, 99_000).state.phase).toBe("paused");

    const resumed = action(paused, { type: "resume" }, 100_000);
    expect(resumed.phase).toBe("suggestions");
    expect(resumed.phaseEndsAt).toBe(107_000);
  });

  it("expires an uncompleted challenge when server time reaches its deadline", () => {
    let state = withVoting();
    state = advanceTime(state, 16_000).state;
    const expired = advanceTime(state, 36_000).state;
    expect(expired.phase).toBe("expired");
    expect(expired.phaseEndsAt).toBeNull();
  });

  it("does not extend the challenge deadline when the server timer runs late", () => {
    let state = withVoting();
    state = advanceTime(state, 50_000).state;
    expect(state.phase).toBe("expired");
    expect(state.phaseEndsAt).toBeNull();
  });

  it("allows cancellation then reset without losing revision ordering", () => {
    const started = action(createInitialState(), { type: "start-round", config }, 1_000);
    const cancelled = action(started, { type: "cancel" }, 2_000);
    const reset = action(cancelled, { type: "reset" }, 3_000);
    expect(cancelled.phase).toBe("cancelled");
    expect(reset.phase).toBe("idle");
    expect(reset.revision).toBe(cancelled.revision + 1);
  });
});

describe("chat command validation", () => {
  it("parses case-insensitive commands and ignores ordinary chat", () => {
    expect(parseChatCommand("!SuGgEsT   Use a shield")).toEqual({
      kind: "command",
      command: { type: "suggest", text: "Use a shield" },
    });
    expect(parseChatCommand("!vote c")).toEqual({ kind: "command", command: { type: "vote", label: "C" } });
    expect(parseChatCommand("!charge")).toEqual({ kind: "command", command: { type: "charge" } });
    expect(parseChatCommand("hello chat")).toEqual({ kind: "ignore" });
  });

  it("rejects empty, overlong, malformed, and argument-bearing commands", () => {
    expect(parseChatCommand("!suggest   ")).toMatchObject({ kind: "invalid", error: "invalid-idea" });
    expect(parseChatCommand(`!suggest ${"a".repeat(121)}`)).toMatchObject({ kind: "invalid", error: "invalid-idea" });
    expect(parseChatCommand("!vote AB")).toMatchObject({ kind: "invalid", error: "invalid-vote" });
    expect(parseChatCommand("!charge please")).toMatchObject({ kind: "invalid", error: "invalid-arguments" });
    expect(parseChatCommand("!unknown value")).toMatchObject({ kind: "invalid", error: "invalid-command" });
    expect(parseChatCommand("!charge" + "x".repeat(500))).toMatchObject({ kind: "invalid", error: "invalid-command" });
  });

  it("accepts at most one suggestion per viewer and rejects duplicate ideas", () => {
    let state = action(createInitialState(), { type: "start-round", config }, 1_000);
    state = chat(state, "viewer-1", "!suggest  Use a   shield ", 2_000).state;
    const duplicateUser = chat(state, "viewer-1", "!suggest Build a bridge", 2_100);
    const duplicateIdea = chat(state, "viewer-2", "!suggest use a shield", 2_200);

    expect(state.suggestions[0]?.text).toBe("Use a   shield");
    expect(duplicateUser).toMatchObject({ accepted: false, error: "duplicate-suggestion" });
    expect(duplicateIdea).toMatchObject({ accepted: false, error: "duplicate-idea" });
  });

  it("accepts one vote per viewer for an approved candidate", () => {
    const voting = withVoting();
    const vote = chat(voting, "voter-1", "!vote a", 12_000);
    const secondVote = chat(vote.state, "voter-1", "!vote B", 12_200);
    const unapproved = chat(voting, "voter-2", "!vote C", 12_300);

    expect(vote.accepted).toBe(true);
    expect(secondVote).toMatchObject({ accepted: false, error: "already-voted" });
    expect(unapproved).toMatchObject({ accepted: false, error: "invalid-candidate" });
  });

  it("counts server-received charges, enforces cooldown, and completes at the goal", () => {
    let state = withVoting();
    state = advanceTime(state, 16_000).state;
    const first = chat(state, "charger-1", "!charge", 16_100);
    const tooSoon = chat(first.state, "charger-1", "!charge", 16_900);
    const second = chat(first.state, "charger-2", "!charge", 17_000);
    const third = chat(second.state, "charger-3", "!charge", 17_100);

    expect(first.state.charge).toBe(1);
    expect(tooSoon).toMatchObject({ accepted: false, error: "charge-cooldown" });
    expect(third.state).toMatchObject({ phase: "succeeded", charge: 3, contributionCount: 3, phaseEndsAt: null });
  });

  it("rejects chat commands outside their active phase", () => {
    const result = chat(createInitialState(), "viewer-1", "!charge", 1_000);
    expect(result).toMatchObject({ accepted: false, error: "invalid-phase" });
  });
});
