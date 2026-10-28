import {
  advanceTime,
  applyChatCommand,
  applyStreamerAction,
  createInitialState,
  parseChatCommand,
  type ChallengeConfig,
  type ChallengeState,
  type ChatCommand,
  type StreamerAction,
} from "../../domain/challenge.js";
import type { PublicOverlayState } from "../state.js";

export const DEMO_CONFIG: ChallengeConfig = {
  suggestionDurationMs: 5_000,
  votingDurationMs: 5_000,
  challengeDurationMs: 30_000,
  chargeGoal: 4,
  chargePerMessage: 1,
};

export type DemoScriptStep =
  | "idle"
  | "suggest"
  | "suggestion-deadline"
  | "approve"
  | "vote"
  | "voting-deadline"
  | "charge-one"
  | "charge-two"
  | "charge-three"
  | "charge-four"
  | "done";

export interface DemoRound {
  challenge: ChallengeState;
  now: number;
  wallUpdatedAt: number;
  scriptStep: DemoScriptStep;
  feedback: string;
}

const demoStreamer = { streamerId: "local-demo" } as const;

export function createDemoRound(now = Date.now()): DemoRound {
  return { challenge: createInitialState(), now, wallUpdatedAt: now, scriptStep: "idle", feedback: "Ready for a local round." };
}

export function tickDemoRound(round: DemoRound, wallNow: number): DemoRound {
  const elapsed = Math.max(0, wallNow - round.wallUpdatedAt);
  const now = round.now + elapsed;
  const advanced = round.challenge.phaseEndsAt !== null && now >= round.challenge.phaseEndsAt
    ? advanceTime(round.challenge, now)
    : null;
  return { ...round, now, wallUpdatedAt: wallNow, challenge: advanced?.accepted ? advanced.state : round.challenge };
}

export function restartDemoRound(round: DemoRound, wallNow = Date.now()): DemoRound {
  const reset = applyStreamerAction(round.challenge, demoStreamer, { type: "reset" }, round.now);
  const started = applyStreamerAction(reset.state, demoStreamer, { type: "start-round", config: DEMO_CONFIG }, round.now + 1);
  if (!reset.accepted || !started.accepted) return { ...round, feedback: "The local round could not be restarted." };
  return { ...round, challenge: started.state, now: round.now + 1, wallUpdatedAt: wallNow, scriptStep: "idle", feedback: "Suggestion round started locally." };
}

export function sendDemoCommand(round: DemoRound, message: string, viewerId: string, wallNow = Date.now()): DemoRound {
  const parsed = parseChatCommand(message);
  if (parsed.kind !== "command") return { ...round, wallUpdatedAt: wallNow, feedback: parsed.kind === "invalid" ? `Command rejected: ${parsed.error}.` : "That message is not a CrowdQuest command." };
  return applyDemoCommand(round, parsed.command, viewerId, wallNow);
}

export function advanceDemoScript(round: DemoRound, wallNow = Date.now()): DemoRound {
  const current = tickDemoRound(round, wallNow);
  switch (current.scriptStep) {
    case "idle":
      return { ...restartDemoRound(current, wallNow), scriptStep: "suggest" };
    case "suggest":
      return { ...sendDemoCommand(current, "!suggest No jumping", "demo-viewer-1", wallNow), scriptStep: "suggestion-deadline" };
    case "suggestion-deadline": {
      const next = current.challenge.phaseEndsAt === null ? current : withEngineState(current, advanceTime(current.challenge, current.challenge.phaseEndsAt), wallNow);
      return { ...next, scriptStep: "approve", feedback: "Suggestion window closed. Reviewing the local idea." };
    }
    case "approve": {
      const ids = current.challenge.suggestions.slice(0, 1).map((item) => item.id);
      const next = applyDemoAction(current, { type: "approve-candidates", suggestionIds: ids }, wallNow);
      return { ...next, scriptStep: "vote", feedback: "Candidate A is open for local votes." };
    }
    case "vote":
      return { ...sendDemoCommand(current, "!vote A", "demo-viewer-2", wallNow), scriptStep: "voting-deadline" };
    case "voting-deadline": {
      const next = current.challenge.phaseEndsAt === null ? current : withEngineState(current, advanceTime(current.challenge, current.challenge.phaseEndsAt), wallNow);
      return { ...next, scriptStep: "charge-one", feedback: "The community picked a modifier. Quest is active." };
    }
    case "charge-one":
    case "charge-two":
    case "charge-three":
    case "charge-four": {
      const ordinal = current.scriptStep === "charge-one" ? 1 : current.scriptStep === "charge-two" ? 2 : current.scriptStep === "charge-three" ? 3 : 4;
      const next = sendDemoCommand(current, "!charge", `demo-viewer-${ordinal + 2}`, wallNow);
      const scriptStep = ordinal === 1 ? "charge-two" : ordinal === 2 ? "charge-three" : ordinal === 3 ? "charge-four" : "done";
      return { ...next, scriptStep, feedback: next.challenge.phase === "succeeded" ? "Quest complete. The local community filled the meter." : `Local charge ${ordinal} of ${DEMO_CONFIG.chargeGoal}.` };
    }
    case "done":
      return current;
  }
}

export function toDemoOverlayState(challenge: ChallengeState): PublicOverlayState {
  const voteCounts = Object.fromEntries(challenge.candidates.map((candidate) => [candidate.id, Object.values(challenge.votes).filter((id) => id === candidate.id).length]));
  return {
    challenge: {
      revision: challenge.revision,
      phase: challenge.phase,
      config: challenge.config,
      phaseEndsAt: challenge.phaseEndsAt,
      pausedRemainingMs: challenge.pausedRemainingMs,
      candidates: challenge.candidates.map(({ id, label, text }) => ({ id, label, text })),
      voteCounts,
      contributionCount: challenge.contributionCount,
      charge: challenge.charge,
      winningCandidateId: challenge.winningCandidateId,
    },
    challengeSource: "simulated",
    twitch: { connection: "stopped", subscription: "none" },
  };
}

function applyDemoCommand(round: DemoRound, command: ChatCommand, viewerId: string, wallNow: number): DemoRound {
  const current = tickDemoRound(round, wallNow);
  const result = applyChatCommand(current.challenge, viewerId, command, current.now);
  return result.accepted
    ? { ...current, challenge: result.state, feedback: `${command.type} accepted from local demo chat.` }
    : { ...current, feedback: `Command rejected: ${result.error}.` };
}

function applyDemoAction(round: DemoRound, action: StreamerAction, wallNow: number): DemoRound {
  const current = tickDemoRound(round, wallNow);
  const result = applyStreamerAction(current.challenge, demoStreamer, action, current.now);
  return result.accepted ? { ...current, challenge: result.state } : { ...current, feedback: `Local action rejected: ${result.error}.` };
}

function withEngineState(round: DemoRound, result: ReturnType<typeof advanceTime>, wallNow: number): DemoRound {
  return result.accepted ? { ...round, challenge: result.state, now: Math.max(round.now, round.challenge.phaseEndsAt ?? round.now), wallUpdatedAt: wallNow } : { ...round, feedback: `The local clock could not advance: ${result.error}.` };
}
