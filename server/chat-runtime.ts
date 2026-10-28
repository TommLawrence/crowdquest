import {
  advanceTime,
  applyChatCommand,
  parseChatCommand,
  type ChallengeState,
} from "../src/domain/challenge.js";
import type { IncomingChatMessage } from "./chat-message.js";

export interface CommandDiagnostic {
  name: string;
  outcome: string;
  at: number;
  source: EventSource;
}

export type EventSource = "live" | "simulated";

export interface ChatActivity {
  id: string;
  source: EventSource;
  actor: string;
  command: string;
  outcome: string;
  detail: string | null;
  at: number;
}

export interface SuggestionMetadata {
  source: EventSource;
  actor: string;
}

const MAX_ACTIVITY = 24;
const MAX_SUGGESTION_METADATA = 500;

export class ChatRuntime {
  private messagesReceived = 0;
  private simulatedMessagesReceived = 0;
  private lastMessageAt: number | null = null;
  private latestCommand: CommandDiagnostic | null = null;
  private readonly activity: ChatActivity[] = [];
  private readonly suggestionMetadata: Record<string, SuggestionMetadata> = {};
  private lastPublishedAt = 0;
  private publishTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly getState: () => ChallengeState,
    private readonly setState: (state: ChallengeState) => void,
    private readonly serverNow: () => number = Date.now,
    private readonly getRoundSource: () => EventSource | null = () => null,
    private readonly onChange: () => void = () => {},
  ) {}

  receive(message: IncomingChatMessage, source: EventSource = "live"): void {
    if (source === "simulated") this.simulatedMessagesReceived += 1;
    else {
      this.messagesReceived += 1;
      this.lastMessageAt = message.timestamp;
    }
    const parsed = parseChatCommand(message.text);
    if (parsed.kind === "ignore") {
      this.schedulePublish();
      return;
    }

    if (parsed.kind === "invalid") {
      const name = commandNameFromText(message.text);
      this.latestCommand = { name, outcome: parsed.error, at: message.timestamp, source };
      this.addActivity(message, source, name, parsed.error, null);
      this.publishNow();
      return;
    }

    const now = this.serverNow();
    const advanced = advanceTime(this.getState(), now);
    const roundSource = this.getRoundSource();
    const transition = roundSource && roundSource !== source
      ? { accepted: false as const, state: advanced.state, error: "source-mismatch" }
      : applyChatCommand(advanced.state, message.userId, parsed.command, now);
    this.setState(transition.state);

    let detail: string | null = null;
    if (parsed.command.type === "suggest" && transition.accepted) {
      const suggestion = transition.state.suggestions.find((item) => item.userId === message.userId);
      if (suggestion) {
        this.suggestionMetadata[suggestion.id] = { source, actor: message.displayName };
        const metadataIds = Object.keys(this.suggestionMetadata);
        if (metadataIds.length > MAX_SUGGESTION_METADATA && metadataIds[0]) delete this.suggestionMetadata[metadataIds[0]];
        detail = suggestion.text;
      }
    } else if (parsed.command.type === "vote") {
      detail = parsed.command.label;
    }
    const outcome = transition.accepted ? "accepted" : transition.error;
    this.latestCommand = { name: parsed.command.type, outcome, at: message.timestamp, source };
    this.addActivity(message, source, parsed.command.type, outcome, detail);
    this.publishNow();
  }

  stop(): void {
    if (this.publishTimer) clearTimeout(this.publishTimer);
    this.publishTimer = null;
  }

  snapshot(): {
    messagesReceived: number;
    simulatedMessagesReceived: number;
    lastMessageAt: number | null;
    latestCommand: CommandDiagnostic | null;
    activity: ChatActivity[];
    suggestionMetadata: Record<string, SuggestionMetadata>;
  } {
    return {
      messagesReceived: this.messagesReceived,
      simulatedMessagesReceived: this.simulatedMessagesReceived,
      lastMessageAt: this.lastMessageAt,
      latestCommand: this.latestCommand ? { ...this.latestCommand } : null,
      activity: this.activity.map((item) => ({ ...item })),
      suggestionMetadata: Object.fromEntries(
        Object.entries(this.suggestionMetadata).map(([id, value]) => [id, { ...value }]),
      ),
    };
  }

  private addActivity(message: IncomingChatMessage, source: EventSource, command: string, outcome: string, detail: string | null): void {
    this.activity.unshift({
      id: `${source}:${message.messageId}`,
      source,
      actor: message.displayName,
      command,
      outcome,
      detail,
      at: message.timestamp,
    });
    this.activity.length = Math.min(this.activity.length, MAX_ACTIVITY);
  }

  private publishNow(): void {
    if (this.publishTimer) clearTimeout(this.publishTimer);
    this.publishTimer = null;
    this.lastPublishedAt = Date.now();
    this.onChange();
  }

  private schedulePublish(): void {
    const elapsed = Date.now() - this.lastPublishedAt;
    if (elapsed >= 250) {
      this.lastPublishedAt = Date.now();
      this.onChange();
    } else if (!this.publishTimer) {
      this.publishTimer = setTimeout(() => {
        this.publishTimer = null;
        this.lastPublishedAt = Date.now();
        this.onChange();
      }, 250 - elapsed);
    }
  }
}

function commandNameFromText(text: string): string {
  const match = /^\s*!(suggest|vote|charge)\b/i.exec(text);
  return match?.[1]?.toLowerCase() ?? "invalid";
}
