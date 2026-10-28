import type { PublicOverlayState } from "../state.js";
import type { RealtimeStatus } from "../useAppState.js";

export function Overlay({ state, connection, serverNow }: {
  state: PublicOverlayState | null;
  connection: RealtimeStatus;
  serverNow: number;
}) {
  const challenge = state?.challenge;
  const modifier = challenge?.candidates.find((candidate) => candidate.id === challenge.winningCandidateId) ?? null;
  const countdown = challenge?.phase === "paused"
    ? challenge.pausedRemainingMs === null ? null : Math.ceil(challenge.pausedRemainingMs / 1_000)
    : challenge?.phaseEndsAt === null || !challenge ? null : Math.max(0, Math.ceil((challenge.phaseEndsAt - serverNow) / 1_000));
  const progress = challenge?.config ? Math.min(100, challenge.charge / challenge.config.chargeGoal * 100) : 0;
  const disconnected = connection !== "connected";
  const twitchReconnecting = Boolean(challenge && state?.challengeSource === "live" &&
    (state.twitch.connection !== "connected" || state.twitch.subscription !== "enabled"));
  const idle = !challenge || challenge.phase === "idle";

  return <main className="overlay-root" aria-label="CrowdQuest OBS overlay">
    <div className="overlay-safe-area">
      {(disconnected || twitchReconnecting) && <div className="overlay-connection" role="status"><i />
        {disconnected ? state ? "RECONNECTING TO QUEST" : "CONNECTING TO QUEST" : "TWITCH CHAT RECONNECTING"}
      </div>}
      {idle ? <section className="overlay-idle">
        <span className="overlay-brand"><b>CQ</b> CROWDQUEST <i>LIVE</i></span>
        <strong>Waiting for the next community quest</strong>
        <span>Chat will help write the rules.</span>
      </section> : <section className={`overlay-quest overlay-${challenge.phase}`}>
        <div className="overlay-topline">
          <span className="overlay-brand"><b>CQ</b> CROWDQUEST <i>LIVE</i></span>
          <span className="overlay-stage">{phaseName(challenge.phase)}</span>
          {state?.challengeSource === "simulated" && <span className="sim-tag sim-tag-large">DEMO</span>}
        </div>
        <div className="overlay-content">
          <div className="overlay-title-block">
            <span className="overlay-kicker">COMMUNITY QUEST</span>
            <h1>{challenge.phase === "suggestions" ? "Chat is writing the rules" : challenge.phase === "review" ? "A new quest is taking shape" : "The community challenge"}</h1>
            {modifier && <p className="overlay-modifier"><span>{challenge.phase === "voting" ? "LEADING MODIFIER" : "WINNING MODIFIER"} · {modifier.label}</span>{modifier.text}</p>}
          </div>
          {countdown !== null && <div className="overlay-clock"><strong>{formatCountdown(countdown)}</strong><span>{challenge.phase === "paused" ? "PAUSED" : "TIME LEFT"}</span></div>}
        </div>
        {challenge.phase === "voting" && <div className="overlay-votes" aria-label="Current vote totals">
          {challenge.candidates.map((candidate) => <div className="overlay-vote-row" key={candidate.id}>
            <div className="overlay-vote-copy"><b>{candidate.label}</b><span>{candidate.text}</span><strong>{challenge.voteCounts[candidate.id] ?? 0}</strong></div>
            <div className="overlay-vote-track"><i style={{ width: `${voteWidth(challenge.voteCounts[candidate.id] ?? 0, challenge.voteCounts)}` }} /></div>
          </div>)}
          <span className="overlay-viewer-hint">VOTE IN CHAT · !VOTE A / B / C</span>
        </div>}
        {["active", "paused", "succeeded", "expired"].includes(challenge.phase) && <div className="overlay-progress">
          <div className="overlay-progress-heading"><span>{challenge.phase === "succeeded" ? "COMMUNITY SUCCESS" : challenge.phase === "expired" ? "TIME EXPIRED" : challenge.phase === "paused" ? "QUEST PAUSED" : "SHARED CHARGE"}</span><strong>{challenge.charge}<i> / {challenge.config?.chargeGoal ?? 0}</i></strong></div>
          <div className="overlay-progress-track"><i style={{ width: `${progress}%` }} /></div>
          <div className="overlay-progress-foot"><span>{challenge.contributionCount} community contributions</span>{challenge.phase === "active" && <span>TYPE !CHARGE TO HELP</span>}</div>
        </div>}
        {(challenge.phase === "succeeded" || challenge.phase === "expired") && <div className="overlay-outcome" role="status"><span aria-hidden="true">{challenge.phase === "succeeded" ? "✦" : "◷"}</span><strong>{challenge.phase === "succeeded" ? "Quest complete" : "The clock ran out"}</strong></div>}
        {challenge.phase === "suggestions" && <div className="overlay-viewer-hint overlay-suggest-hint">ADD AN IDEA IN CHAT · !SUGGEST YOUR MODIFIER</div>}
      </section>}
    </div>
  </main>;
}

function phaseName(phase: string): string {
  const names: Record<string, string> = { suggestions: "IDEAS OPEN", review: "STREAMER REVIEW", voting: "VOTING OPEN", active: "QUEST ACTIVE", paused: "PAUSED", succeeded: "QUEST COMPLETE", expired: "TIME EXPIRED", cancelled: "CANCELLED" };
  return names[phase] ?? phase.toUpperCase();
}

function formatCountdown(seconds: number): string {
  return `${Math.floor(seconds / 60).toString().padStart(2, "0")}:${(seconds % 60).toString().padStart(2, "0")}`;
}

function voteWidth(count: number, counts: Record<string, number>): string {
  const total = Object.values(counts).reduce((sum, current) => sum + current, 0);
  return `${total === 0 ? 0 : count / total * 100}%`;
}

