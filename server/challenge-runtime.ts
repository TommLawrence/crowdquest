import {
  advanceTime,
  applyStreamerAction,
  createInitialState,
  type ChallengeState,
  type StreamerAction,
  type TransitionResult,
} from "../src/domain/challenge.js";
import type { IncomingChatMessage } from "./chat-message.js";
import { ChatRuntime, type EventSource } from "./chat-runtime.js";

export class ChallengeRuntime {
  private stateValue = createInitialState();
  private sourceValue: EventSource | null = null;
  readonly chat: ChatRuntime;

  constructor(private readonly onChange: () => void = () => {}, private readonly now: () => number = Date.now) {
    this.chat = new ChatRuntime(
      () => this.stateValue,
      (state) => { this.stateValue = state; },
      this.now,
      () => this.sourceValue,
      onChange,
    );
  }

  get state(): ChallengeState {
    return structuredClone(this.stateValue);
  }

  get source(): EventSource | null {
    return this.sourceValue;
  }

  advance(nowMs = this.now()): void {
    const result = advanceTime(this.stateValue, nowMs);
    if (result.state !== this.stateValue) this.commit(result.state);
  }

  act(principal: { streamerId: string; mode?: "twitch" | "simulation" }, action: StreamerAction, nowMs = this.now()): TransitionResult {
    this.advance(nowMs);
    const principalSource = principal.mode === "simulation" ? "simulated" : "live";
    if (this.sourceValue && principalSource !== this.sourceValue) {
      return { accepted: false, state: this.state, error: "source-mismatch" };
    }
    const result = applyStreamerAction(this.stateValue, principal, action, nowMs);
    if (!result.accepted) return { ...result, state: this.state };

    if (action.type === "start-round") this.sourceValue = principal.mode === "simulation" ? "simulated" : "live";
    if (action.type === "reset") this.sourceValue = null;
    this.commit(result.state);
    return { accepted: true, state: this.state };
  }

  receive(message: IncomingChatMessage, source: EventSource = "live"): void {
    this.chat.receive(message, source);
  }

  snapshot(): {
    challenge: ChallengeState;
    source: EventSource | null;
    chat: ReturnType<ChatRuntime["snapshot"]>;
  } {
    return { challenge: this.state, source: this.sourceValue, chat: this.chat.snapshot() };
  }

  private commit(state: ChallengeState): void {
    this.stateValue = state;
    this.onChange();
  }
}
