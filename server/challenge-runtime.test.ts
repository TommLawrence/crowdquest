import { describe, expect, it } from "vitest";
import { createInitialState, type ChallengeConfig } from "../src/domain/challenge.js";
import { ChallengeRuntime } from "./challenge-runtime.js";

const config: ChallengeConfig = {
  suggestionDurationMs: 10_000,
  votingDurationMs: 5_000,
  challengeDurationMs: 20_000,
  chargeGoal: 2,
  chargePerMessage: 1,
};

let clock = 1_000;
const livePrincipal = { streamerId: "broadcaster-id", mode: "twitch" as const };
const simulatedPrincipal = { streamerId: "local-simulation-operator", mode: "simulation" as const };

function message(source: "live" | "simulated", text: string, messageId: string, userId: string) {
  return {
    notificationId: `${source}:${messageId}`,
    messageId: `${source}:${messageId}`,
    broadcasterId: source === "live" ? "broadcaster-id" : "simulated-channel",
    userId,
    login: source === "live" ? "viewer" : "simulation_viewer_1",
    displayName: source === "live" ? "RealViewer" : "Demo Viewer 1",
    text,
    timestamp: clock,
  };
}

describe("server challenge runtime", () => {
  it("uses the same engine for both sources and keeps simulated commands out of live rounds", () => {
    clock = 1_000;
    const runtime = new ChallengeRuntime(() => {}, () => clock);
    runtime.act(livePrincipal, { type: "start-round", config }, clock);
    runtime.receive(message("simulated", "!suggest Simulated idea", "s-1", "sim-user-1"), "simulated");
    expect(runtime.state.suggestions).toHaveLength(0);
    expect(runtime.chat.snapshot().activity[0]).toMatchObject({ source: "simulated", outcome: "source-mismatch" });

    runtime.receive(message("live", "!suggest Real idea", "l-1", "viewer-1"), "live");
    expect(runtime.state.suggestions.map((item) => item.text)).toEqual(["Real idea"]);
    expect(runtime.source).toBe("live");
    expect(runtime.chat.snapshot()).toMatchObject({ messagesReceived: 1, simulatedMessagesReceived: 1 });
  });

  it("labels simulated submissions and keeps the same live parser and engine transitions", () => {
    clock = 2_000;
    const runtime = new ChallengeRuntime(() => {}, () => clock);
    runtime.act(simulatedPrincipal, { type: "start-round", config }, clock);
    expect(runtime.act(livePrincipal, { type: "pause" }, clock)).toMatchObject({ accepted: false, error: "source-mismatch" });
    expect(runtime.state.phase).toBe("suggestions");
    runtime.receive(message("simulated", "!suggest A safely escaped idea", "s-1", "sim-user-1"), "simulated");
    expect(runtime.source).toBe("simulated");
    expect(runtime.state.suggestions).toMatchObject([{ text: "A safely escaped idea" }]);
    const suggestionId = runtime.state.suggestions[0]?.id;
    expect(runtime.chat.snapshot().suggestionMetadata[suggestionId ?? ""]).toEqual({ source: "simulated", actor: "Demo Viewer 1" });

    runtime.receive(message("live", "!suggest Must not join simulation", "l-1", "viewer-1"), "live");
    expect(runtime.state.suggestions).toHaveLength(1);
    expect(runtime.chat.snapshot().activity[0]).toMatchObject({ source: "live", outcome: "source-mismatch" });
  });

  it("advances server timers and publishes only accepted state transitions", () => {
    clock = 3_000;
    let updates = 0;
    const runtime = new ChallengeRuntime(() => { updates += 1; }, () => clock);
    const denied = runtime.act({ streamerId: "" }, { type: "start-round", config }, clock);
    expect(denied).toMatchObject({ accepted: false, error: "unauthorized" });
    expect(runtime.state).toEqual(createInitialState());

    runtime.act(simulatedPrincipal, { type: "start-round", config }, clock);
    runtime.advance(clock + config.suggestionDurationMs);
    expect(runtime.state.phase).toBe("review");
    expect(updates).toBe(2);
  });
});
