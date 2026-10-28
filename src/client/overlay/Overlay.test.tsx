import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { Overlay } from "./Overlay.js";
import type { PublicAppState } from "../state.js";

function state(phase: PublicAppState["challenge"]["phase"]): PublicAppState {
  return {
    challenge: {
      revision: 4,
      phase,
      config: { suggestionDurationMs: 20_000, votingDurationMs: 15_000, challengeDurationMs: 60_000, chargeGoal: 10, chargePerMessage: 1 },
      phaseEndsAt: phase === "paused" || phase === "succeeded" ? null : 100_000,
      pausedFrom: phase === "paused" ? "active" : null,
      pausedRemainingMs: phase === "paused" ? 8_000 : null,
      suggestions: [],
      candidates: [
        { id: "candidate:1", label: "A", text: "<img src=x onerror=alert(1)>", suggestionId: "suggestion:1" },
        { id: "candidate:2", label: "B", text: "No jumping", suggestionId: "suggestion:2" },
      ],
      voteCounts: { "candidate:1": 3, "candidate:2": 1 },
      contributionCount: 4,
      charge: phase === "succeeded" ? 10 : 4,
      winningCandidateId: phase === "active" || phase === "succeeded" ? "candidate:1" : null,
    },
    challengeSource: "simulated",
    suggestionMetadata: {},
    activity: [],
    chat: { messagesReceived: 0, simulatedMessagesReceived: 5, lastMessageAt: null, latestCommand: null },
    twitch: { configured: false, connected: false, connection: "stopped", subscription: "none", reconnectAttempts: 0, error: null },
    simulatedChatEnabled: true,
  };
}

describe("OBS overlay rendering", () => {
  it("renders voting options, totals, timer, and the demo label without controls", () => {
    const markup = renderToStaticMarkup(<Overlay state={state("voting")} connection="connected" serverNow={90_000} />);
    expect(markup).toContain("VOTING OPEN");
    expect(markup).toContain("!VOTE A / B / C");
    expect(markup).toContain("00:10");
    expect(markup).toContain("DEMO");
    expect(markup).toContain("3");
    expect(markup).not.toContain("<button");
    expect(markup).not.toContain("<form");
  });

  it("renders active progress and escapes viewer supplied modifier text", () => {
    const markup = renderToStaticMarkup(<Overlay state={state("active")} connection="connected" serverNow={90_000} />);
    expect(markup).toContain("SHARED CHARGE");
    expect(markup).toContain("40%");
    expect(markup).toContain("TYPE !CHARGE TO HELP");
    expect(markup).toContain("&lt;img src=x onerror=alert(1)&gt;");
    expect(markup).not.toContain("<img");
    expect(markup).not.toContain("<script");
  });

  it("shows distinct success, expiry, idle, and reconnect states", () => {
    const success = renderToStaticMarkup(<Overlay state={state("succeeded")} connection="connected" serverNow={100_000} />);
    const expired = renderToStaticMarkup(<Overlay state={state("expired")} connection="reconnecting" serverNow={100_000} />);
    const idle = renderToStaticMarkup(<Overlay state={null} connection="connecting" serverNow={0} />);
    expect(success).toContain("Quest complete");
    expect(success).toContain("COMMUNITY SUCCESS");
    expect(expired).toContain("The clock ran out");
    expect(expired).toContain("RECONNECTING TO QUEST");
    expect(idle).toContain("Waiting for the next community quest");
    expect(idle).toContain("CONNECTING TO QUEST");

    const live = state("active");
    live.challengeSource = "live";
    live.twitch.connection = "reconnecting";
    expect(renderToStaticMarkup(<Overlay state={live} connection="connected" serverNow={90_000} />)).toContain("TWITCH CHAT RECONNECTING");
  });
});
