import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { getOverlayVisualState, Overlay } from "./Overlay.js";
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
    expect(markup).toContain("SOUND ON");
    expect(markup.match(/<button/g)).toHaveLength(1);
    expect(markup).not.toContain("<form");
  });

  it("renders active progress and escapes viewer supplied modifier text", () => {
    const markup = renderToStaticMarkup(<Overlay state={state("active")} connection="connected" serverNow={90_000} />);
    expect(markup).toContain("SHARED CHARGE");
    expect(markup).toContain("scaleX(0.4)");
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

  it("maps charge milestones, urgency, and terminal phases to distinct visual states", () => {
    expect(getOverlayVisualState("active", 1, 4, 30)).toMatchObject({ mood: "active", milestone: 25, ratio: .25 });
    expect(getOverlayVisualState("active", 2, 4, 9)).toMatchObject({ mood: "urgent", milestone: 50, ratio: .5 });
    expect(getOverlayVisualState("active", 3, 4, 20)).toMatchObject({ mood: "active", milestone: 75, ratio: .75 });
    expect(getOverlayVisualState("succeeded", 4, 4, null)).toMatchObject({ mood: "success", milestone: 100, ratio: 1 });
    expect(getOverlayVisualState("expired", 2, 4, null).mood).toBe("expired");
    expect(getOverlayVisualState("cancelled", 0, 4, null).mood).toBe("cancelled");

    const urgent = state("active");
    urgent.challenge.charge = 5;
    const markup = renderToStaticMarkup(<Overlay state={urgent} connection="connected" serverNow={99_000} />);
    expect(markup).toContain('data-overlay-urgent="true"');
    expect(markup).toContain('data-charge-milestone="50"');
  });
});
