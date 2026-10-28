import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { DemoPage } from "./DemoPage.js";
import { advanceDemoScript, createDemoRound, toDemoOverlayState } from "./round.js";

describe("public demo sandbox", () => {
  it("plays a deterministic local round through suggestion, vote, charge, and success", () => {
    let round = createDemoRound(1_000);
    let wallNow = 1_000;
    for (let step = 0; step < 20 && round.scriptStep !== "done"; step += 1) {
      wallNow += 650;
      round = advanceDemoScript(round, wallNow);
    }
    expect(round.scriptStep).toBe("done");
    expect(round.challenge.phase).toBe("succeeded");
    expect(round.challenge.charge).toBe(4);
    expect(round.challenge.winningCandidateId).toBe(round.challenge.candidates[0]?.id);
  });

  it("renders its local-only label and the shared overlay without privileged controls", () => {
    const markup = renderToStaticMarkup(<DemoPage />);
    expect(markup).toContain("Demo; simulated chat");
    expect(markup).toContain("no Twitch connection");
    expect(markup).toContain("Waiting for the next community quest");
    expect(markup).toContain("Start / restart round");
    expect(markup).not.toContain("api/");
    expect(markup).not.toContain("Convex");
  });

  it("keeps the simulated source visible in the overlay state model", () => {
    expect(toDemoOverlayState(createDemoRound(100).challenge)).toMatchObject({
      challengeSource: "simulated",
      twitch: { connection: "stopped", subscription: "none" },
    });
  });
});
