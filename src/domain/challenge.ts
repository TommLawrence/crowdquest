export type ChallengePhase =
  | "idle"
  | "suggestions"
  | "review"
  | "voting"
  | "active"
  | "paused"
  | "succeeded"
  | "expired"
  | "cancelled";

export interface ChallengeConfig {
  suggestionDurationMs: number;
  votingDurationMs: number;
  challengeDurationMs: number;
  chargeGoal: number;
  chargePerMessage: number;
}

export interface Suggestion {
  id: string;
  userId: string;
  text: string;
  normalizedText: string;
  submittedAt: number;
}

export interface Candidate {
  id: string;
  label: "A" | "B" | "C";
  text: string;
  suggestionId: string;
}

export interface ChallengeState {
  revision: number;
  phase: ChallengePhase;
  config: ChallengeConfig | null;
  phaseEndsAt: number | null;
  pausedFrom: Exclude<ChallengePhase, "paused"> | null;
  pausedRemainingMs: number | null;
  suggestions: Suggestion[];
  candidates: Candidate[];
  votes: Record<string, string>;
  contributionCount: number;
  charge: number;
  winningCandidateId: string | null;
  lastChargeAtByUser: Record<string, number>;
  suggestionIdByUser: Record<string, string>;
}

export type StreamerAction =
  | { type: "start-round"; config: ChallengeConfig }
  | { type: "approve-candidates"; suggestionIds: string[] }
  | { type: "pause" }
  | { type: "resume" }
  | { type: "cancel" }
  | { type: "reset" };

export interface StreamerPrincipal {
  readonly streamerId: string;
}

export type TransitionError =
  | "unauthorized"
  | "invalid-phase"
  | "invalid-config"
  | "invalid-candidates"
  | "source-mismatch"
  | "invalid-timestamp";

export type TransitionResult =
  | { accepted: true; state: ChallengeState }
  | { accepted: false; state: ChallengeState; error: ChatRejection };

const MAX_SUGGESTIONS = 100;
const MAX_CANDIDATES = 3;
const MIN_DURATION_MS = 5_000;
const MAX_DURATION_MS = 3_600_000;
const MAX_CHARGE_GOAL = 1_000_000;
const MAX_CHARGE_PER_MESSAGE = 100;

export function createInitialState(revision = 0): ChallengeState {
  return {
    revision,
    phase: "idle",
    config: null,
    phaseEndsAt: null,
    pausedFrom: null,
    pausedRemainingMs: null,
    suggestions: [],
    candidates: [],
    votes: {},
    contributionCount: 0,
    charge: 0,
    winningCandidateId: null,
    lastChargeAtByUser: {},
    suggestionIdByUser: {},
  };
}

export function applyStreamerAction(
  state: ChallengeState,
  principal: StreamerPrincipal | null,
  action: StreamerAction,
  nowMs: number,
): TransitionResult {
  if (!principal || typeof principal.streamerId !== "string" || !principal.streamerId.trim()) {
    return reject(state, "unauthorized");
  }
  if (!Number.isSafeInteger(nowMs) || nowMs < 0) {
    return reject(state, "invalid-timestamp");
  }

  switch (action.type) {
    case "start-round": {
      if (state.phase !== "idle") return reject(state, "invalid-phase");
      if (!isValidConfig(action.config)) return reject(state, "invalid-config");
      return accept({
        ...createInitialState(state.revision + 1),
        phase: "suggestions",
        config: { ...action.config },
        phaseEndsAt: nowMs + action.config.suggestionDurationMs,
      });
    }
    case "approve-candidates": {
      if (state.phase !== "review" || !state.config) return reject(state, "invalid-phase");
      const ids = action.suggestionIds;
      if (
        ids.length < 1 ||
        ids.length > MAX_CANDIDATES ||
        new Set(ids).size !== ids.length ||
        ids.some((id) => !state.suggestions.some((suggestion) => suggestion.id === id))
      ) {
        return reject(state, "invalid-candidates");
      }

      const candidates = ids.map((id, index) => {
        const suggestion = state.suggestions.find((item) => item.id === id);
        if (!suggestion) throw new Error("Validated suggestion is missing.");
        const label = ("ABC"[index] ?? "A") as Candidate["label"];
        return { id: `candidate:${id}`, label, text: suggestion.text, suggestionId: id };
      });
      return accept({
        ...state,
        revision: state.revision + 1,
        phase: "voting",
        phaseEndsAt: nowMs + state.config.votingDurationMs,
        candidates,
        votes: {},
      });
    }
    case "pause": {
      if (!isTimedPhase(state.phase) || state.phaseEndsAt === null) return reject(state, "invalid-phase");
      return accept({
        ...state,
        revision: state.revision + 1,
        phase: "paused",
        pausedFrom: state.phase,
        pausedRemainingMs: Math.max(0, state.phaseEndsAt - nowMs),
        phaseEndsAt: null,
      });
    }
    case "resume": {
      if (state.phase !== "paused" || !state.pausedFrom || state.pausedRemainingMs === null) {
        return reject(state, "invalid-phase");
      }
      return accept({
        ...state,
        revision: state.revision + 1,
        phase: state.pausedFrom,
        phaseEndsAt: nowMs + state.pausedRemainingMs,
        pausedFrom: null,
        pausedRemainingMs: null,
      });
    }
    case "cancel": {
      if (["idle", "succeeded", "expired", "cancelled"].includes(state.phase)) {
        return reject(state, "invalid-phase");
      }
      return accept({
        ...state,
        revision: state.revision + 1,
        phase: "cancelled",
        phaseEndsAt: null,
        pausedFrom: null,
        pausedRemainingMs: null,
      });
    }
    case "reset":
      return accept(createInitialState(state.revision + 1));
  }
}

export function advanceTime(state: ChallengeState, nowMs: number): TransitionResult {
  if (!Number.isSafeInteger(nowMs) || nowMs < 0) return reject(state, "invalid-timestamp");
  if (state.phaseEndsAt === null || nowMs < state.phaseEndsAt) return accept(state);

  switch (state.phase) {
    case "suggestions":
      return accept({ ...state, revision: state.revision + 1, phase: "review", phaseEndsAt: null });
    case "voting": {
      const winner = selectWinner(state.candidates, state.votes);
      if (!winner || !state.config) return reject(state, "invalid-phase");
      const challengeDeadline = state.phaseEndsAt + state.config.challengeDurationMs;
      if (nowMs >= challengeDeadline) {
        return accept({ ...state, revision: state.revision + 1, phase: "expired", phaseEndsAt: null });
      }
      return accept({
        ...state,
        revision: state.revision + 1,
        phase: "active",
        phaseEndsAt: challengeDeadline,
        winningCandidateId: winner.id,
      });
    }
    case "active":
      return accept({ ...state, revision: state.revision + 1, phase: "expired", phaseEndsAt: null });
    default:
      return accept(state);
  }
}

export function applyChatCommand(
  state: ChallengeState,
  userId: string,
  command: ChatCommand,
  nowMs: number,
): TransitionResult {
  if (!Number.isSafeInteger(nowMs) || nowMs < 0) return reject(state, "invalid-timestamp");
  if (!isValidUserId(userId)) return reject(state, "invalid-command");

  switch (command.type) {
    case "suggest": {
      if (state.phase !== "suggestions") return reject(state, "invalid-phase");
      if (state.suggestions.length >= MAX_SUGGESTIONS) return reject(state, "suggestion-limit");
      const userKey = userKeyFor(userId);
      if (state.suggestionIdByUser[userKey]) return reject(state, "duplicate-suggestion");
      const normalizedText = normalizeSuggestion(command.text);
      if (state.suggestions.some((item) => item.normalizedText === normalizedText)) {
        return reject(state, "duplicate-idea");
      }
      const id = `suggestion:${state.revision + 1}`;
      const suggestion: Suggestion = {
        id,
        userId,
        text: command.text.trim(),
        normalizedText,
        submittedAt: nowMs,
      };
      return accept({
        ...state,
        revision: state.revision + 1,
        suggestions: [...state.suggestions, suggestion],
        suggestionIdByUser: { ...state.suggestionIdByUser, [userKey]: id },
      });
    }
    case "vote": {
      if (state.phase !== "voting") return reject(state, "invalid-phase");
      const candidate = state.candidates.find((item) => item.label === command.label);
      if (!candidate) return reject(state, "invalid-candidate");
      const userKey = userKeyFor(userId);
      if (state.votes[userKey]) return reject(state, "already-voted");
      return accept({
        ...state,
        revision: state.revision + 1,
        votes: { ...state.votes, [userKey]: candidate.id },
      });
    }
    case "charge": {
      if (state.phase !== "active" || !state.config) return reject(state, "invalid-phase");
      const userKey = userKeyFor(userId);
      const lastChargeAt = state.lastChargeAtByUser[userKey];
      if (lastChargeAt !== undefined && nowMs - lastChargeAt < 1_000) {
        return reject(state, "charge-cooldown");
      }
      const charge = Math.min(state.config.chargeGoal, state.charge + state.config.chargePerMessage);
      const completed = charge >= state.config.chargeGoal;
      return accept({
        ...state,
        revision: state.revision + 1,
        charge,
        contributionCount: state.contributionCount + 1,
        lastChargeAtByUser: { ...state.lastChargeAtByUser, [userKey]: nowMs },
        phase: completed ? "succeeded" : state.phase,
        phaseEndsAt: completed ? null : state.phaseEndsAt,
      });
    }
  }
}

export type ChatCommand =
  | { type: "suggest"; text: string }
  | { type: "vote"; label: Candidate["label"] }
  | { type: "charge" };

export type ParsedChatCommand =
  | { kind: "command"; command: ChatCommand }
  | { kind: "ignore" }
  | { kind: "invalid"; error: "invalid-command" | "invalid-idea" | "invalid-vote" | "invalid-arguments" };

export function parseChatCommand(message: string): ParsedChatCommand {
  if (typeof message !== "string" || message.length > 500) {
    return { kind: "invalid", error: "invalid-command" };
  }

  const match = /^!(suggest|vote|charge)(?:\s+([\s\S]*))?$/i.exec(message.trim());
  if (!match) {
    return message.trimStart().startsWith("!")
      ? { kind: "invalid", error: "invalid-command" }
      : { kind: "ignore" };
  }

  const name = match[1]?.toLowerCase();
  const argument = match[2]?.trim() ?? "";
  if (name === "suggest") {
    const length = [...argument].length;
    if (!argument || length > 120 || !/[\p{L}\p{N}]/u.test(argument)) {
      return { kind: "invalid", error: "invalid-idea" };
    }
    return { kind: "command", command: { type: "suggest", text: argument } };
  }
  if (name === "vote") {
    if (!/^[abc]$/i.test(argument)) return { kind: "invalid", error: "invalid-vote" };
    return { kind: "command", command: { type: "vote", label: argument.toUpperCase() as Candidate["label"] } };
  }
  if (name === "charge") {
    if (argument) return { kind: "invalid", error: "invalid-arguments" };
    return { kind: "command", command: { type: "charge" } };
  }
  return { kind: "invalid", error: "invalid-command" };
}

export function applyChatMessage(
  state: ChallengeState,
  userId: string,
  message: string,
  nowMs: number,
): TransitionResult {
  const parsed = parseChatCommand(message);
  if (parsed.kind === "ignore") return accept(state);
  if (parsed.kind === "invalid") return reject(state, parsed.error);
  return applyChatCommand(state, userId, parsed.command, nowMs);
}

export type ChatRejection =
  | TransitionError
  | "invalid-command"
  | "invalid-idea"
  | "invalid-vote"
  | "invalid-arguments"
  | "suggestion-limit"
  | "duplicate-suggestion"
  | "duplicate-idea"
  | "invalid-candidate"
  | "already-voted"
  | "charge-cooldown";

function isValidConfig(config: ChallengeConfig): boolean {
  if (typeof config !== "object" || config === null) return false;
  return (
    Number.isSafeInteger(config.suggestionDurationMs) && config.suggestionDurationMs >= MIN_DURATION_MS && config.suggestionDurationMs <= MAX_DURATION_MS &&
    Number.isSafeInteger(config.votingDurationMs) && config.votingDurationMs >= MIN_DURATION_MS && config.votingDurationMs <= MAX_DURATION_MS &&
    Number.isSafeInteger(config.challengeDurationMs) && config.challengeDurationMs >= MIN_DURATION_MS && config.challengeDurationMs <= MAX_DURATION_MS &&
    Number.isInteger(config.chargeGoal) && config.chargeGoal >= 1 && config.chargeGoal <= MAX_CHARGE_GOAL &&
    Number.isInteger(config.chargePerMessage) && config.chargePerMessage >= 1 && config.chargePerMessage <= MAX_CHARGE_PER_MESSAGE
  );
}

function selectWinner(candidates: Candidate[], votes: Record<string, string>): Candidate | null {
  if (candidates.length === 0) return null;
  const voteCounts = new Map(candidates.map((candidate) => [candidate.id, 0]));
  for (const candidateId of Object.values(votes)) {
    if (voteCounts.has(candidateId)) voteCounts.set(candidateId, (voteCounts.get(candidateId) ?? 0) + 1);
  }
  return candidates.reduce((winner, candidate) => {
    if (!winner) return candidate;
    return (voteCounts.get(candidate.id) ?? 0) > (voteCounts.get(winner.id) ?? 0) ? candidate : winner;
  }, null as Candidate | null);
}

function normalizeSuggestion(value: string): string {
  return value.trim().replace(/\s+/g, " ").toLowerCase();
}

function isValidUserId(userId: string): boolean {
  return typeof userId === "string" && userId.length > 0 && userId.length <= 64 && !/[\u0000-\u001f\u007f]/u.test(userId);
}

function userKeyFor(userId: string): string {
  return `user:${userId}`;
}

function isTimedPhase(phase: ChallengePhase): phase is "suggestions" | "voting" | "active" {
  return phase === "suggestions" || phase === "voting" || phase === "active";
}

function accept(state: ChallengeState): TransitionResult {
  return { accepted: true, state };
}

function reject(state: ChallengeState, error: TransitionError | ChatRejection): TransitionResult {
  return { accepted: false, state, error };
}
