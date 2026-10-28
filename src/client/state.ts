export type ChallengePhase = "idle" | "suggestions" | "review" | "voting" | "active" | "paused" | "succeeded" | "expired" | "cancelled";
export type EventSource = "live" | "simulated";

export interface Candidate {
  id: string;
  label: "A" | "B" | "C";
  text: string;
  suggestionId: string;
}

export interface PublicChallenge {
  revision: number;
  phase: ChallengePhase;
  config: {
    suggestionDurationMs: number;
    votingDurationMs: number;
    challengeDurationMs: number;
    chargeGoal: number;
    chargePerMessage: number;
  } | null;
  phaseEndsAt: number | null;
  pausedFrom: ChallengePhase | null;
  pausedRemainingMs: number | null;
  suggestions: Array<{ id: string; text: string; submittedAt: number }>;
  candidates: Candidate[];
  voteCounts: Record<string, number>;
  contributionCount: number;
  charge: number;
  winningCandidateId: string | null;
}

export interface PublicAppState {
  challenge: PublicChallenge;
  challengeSource: EventSource | null;
  suggestionMetadata: Record<string, { source: EventSource; actor: string }>;
  activity: Array<{
    id: string;
    source: EventSource;
    actor: string;
    command: string;
    outcome: string;
    detail: string | null;
    at: number;
  }>;
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
    broadcaster?: { login: string; displayName: string } | null;
    chatReader?: { login: string; displayName: string } | null;
  };
  simulatedChatEnabled: boolean;
}

export type PublicOverlayState = {
  challenge: {
    revision: number;
    phase: ChallengePhase;
    config: PublicChallenge["config"];
    phaseEndsAt: number | null;
    pausedRemainingMs: number | null;
    candidates: Array<Pick<Candidate, "id" | "label" | "text">>;
    voteCounts: Record<string, number>;
    contributionCount: number;
    charge: number;
    winningCandidateId: string | null;
  };
  challengeSource: EventSource | null;
  twitch: Pick<PublicAppState["twitch"], "connection" | "subscription">;
};

export interface TwitchStatus {
  configured: boolean;
  authorized: boolean;
  authenticatedSession: boolean;
  sessionMode: "twitch" | "simulation" | null;
  broadcaster: { login: string; displayName: string } | null;
  chatReader?: { login: string; displayName: string } | null;
  eventSub: { connection: string; subscription: string; reconnectAttempts: number; error: string | null };
  messagesReceived: number;
  lastMessageAt: number | null;
  latestCommand: { name: string; outcome: string; at: number; source: EventSource } | null;
  error: string | null;
}

export interface AppStateEnvelope {
  type: "snapshot" | "update" | "heartbeat";
  sequence: number;
  sentAt: number;
  state?: PublicAppState;
}
