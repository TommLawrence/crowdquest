import type { Candidate, ChallengeState } from "../src/domain/challenge.js";
import type { RuntimeConfig } from "./config.js";
import type { ChatActivity, EventSource, SuggestionMetadata } from "./chat-runtime.js";
import type { ChallengeRuntime } from "./challenge-runtime.js";
import type { TwitchIntegration } from "./twitch-integration.js";

export interface PublicChallengeState {
  revision: number;
  phase: ChallengeState["phase"];
  config: ChallengeState["config"];
  phaseEndsAt: number | null;
  pausedFrom: ChallengeState["pausedFrom"];
  pausedRemainingMs: number | null;
  suggestions: Array<{ id: string; text: string; submittedAt: number }>;
  candidates: Candidate[];
  voteCounts: Record<string, number>;
  contributionCount: number;
  charge: number;
  winningCandidateId: string | null;
}

export interface PublicAppState {
  challenge: PublicChallengeState;
  challengeSource: EventSource | null;
  suggestionMetadata: Record<string, SuggestionMetadata>;
  activity: ChatActivity[];
  chat: {
    messagesReceived: number;
    simulatedMessagesReceived: number;
    lastMessageAt: number | null;
    latestCommand: { name: string; outcome: string; at: number; source: EventSource } | null;
  };
  twitch: {
    configured: boolean;
    connected: boolean;
    connection: string;
    subscription: string;
    reconnectAttempts: number;
    error: string | null;
  };
  simulatedChatEnabled: boolean;
}

export function createPublicAppState(
  runtime: ChallengeRuntime,
  integration: TwitchIntegration,
  config: RuntimeConfig,
): PublicAppState {
  const internal = runtime.snapshot();
  const status = integration.status(null);
  const voteCounts: Record<string, number> = Object.fromEntries(internal.challenge.candidates.map((candidate) => [candidate.id, 0]));
  for (const candidateId of Object.values(internal.challenge.votes)) {
    if (candidateId in voteCounts) voteCounts[candidateId] = (voteCounts[candidateId] ?? 0) + 1;
  }

  return {
    challenge: {
      revision: internal.challenge.revision,
      phase: internal.challenge.phase,
      config: internal.challenge.config ? { ...internal.challenge.config } : null,
      phaseEndsAt: internal.challenge.phaseEndsAt,
      pausedFrom: internal.challenge.pausedFrom,
      pausedRemainingMs: internal.challenge.pausedRemainingMs,
      suggestions: internal.challenge.suggestions.map(({ id, text, submittedAt }) => ({ id, text, submittedAt })),
      candidates: internal.challenge.candidates.map((candidate) => ({ ...candidate })),
      voteCounts,
      contributionCount: internal.challenge.contributionCount,
      charge: internal.challenge.charge,
      winningCandidateId: internal.challenge.winningCandidateId,
    },
    challengeSource: internal.source,
    suggestionMetadata: internal.chat.suggestionMetadata,
    activity: internal.chat.activity,
    chat: {
      messagesReceived: internal.chat.messagesReceived,
      simulatedMessagesReceived: internal.chat.simulatedMessagesReceived,
      lastMessageAt: internal.chat.lastMessageAt,
      latestCommand: internal.chat.latestCommand,
    },
    twitch: {
      configured: status.configured,
      connected: status.authorized,
      connection: status.eventSub.connection,
      subscription: status.eventSub.subscription,
      reconnectAttempts: status.eventSub.reconnectAttempts,
      error: status.error,
    },
    simulatedChatEnabled: config.simulatedChatEnabled,
  };
}
