import type { PublicOverlayState } from "../state.js";
import type { RealtimeStatus } from "../useAppState.js";
import { useEffect, useRef, useState } from "react";
import "./overlay-effects.css";

type OverlayMood = "idle" | "calm" | "active" | "urgent" | "success" | "expired" | "cancelled";
type ChargeMilestone = 0 | 25 | 50 | 75 | 100;

export function getOverlayVisualState(phase: string, charge: number, goal: number, secondsRemaining: number | null): {
  mood: OverlayMood;
  milestone: ChargeMilestone;
  ratio: number;
} {
  const ratio = goal > 0 ? Math.min(1, Math.max(0, charge / goal)) : 0;
  const milestone: ChargeMilestone = ratio >= 1 ? 100 : ratio >= .75 ? 75 : ratio >= .5 ? 50 : ratio >= .25 ? 25 : 0;
  const mood: OverlayMood = phase === "succeeded" ? "success"
    : phase === "expired" ? "expired"
      : phase === "cancelled" ? "cancelled"
        : phase === "idle" ? "idle"
          : phase === "paused" || phase === "review" ? "calm"
            : secondsRemaining !== null && secondsRemaining <= 10 ? "urgent"
              : phase === "active" ? "active" : "calm";
  return { mood, milestone, ratio };
}

export function Overlay({ state, connection, serverNow }: {
  state: PublicOverlayState | null;
  connection: RealtimeStatus;
  serverNow: number;
}) {
  const challenge = state?.challenge;
  const [soundEnabled, setSoundEnabled] = useState(true);
  const previous = useRef<{ revision: number; phase: string; charge: number } | null>(null);
  const modifier = challenge?.candidates.find((candidate) => candidate.id === challenge.winningCandidateId) ?? null;
  const countdown = challenge?.phase === "paused"
    ? challenge.pausedRemainingMs === null ? null : Math.ceil(challenge.pausedRemainingMs / 1_000)
    : challenge?.phaseEndsAt === null || !challenge ? null : Math.max(0, Math.ceil((challenge.phaseEndsAt - serverNow) / 1_000));
  const visual = getOverlayVisualState(challenge?.phase ?? "idle", challenge?.charge ?? 0, challenge?.config?.chargeGoal ?? 0, countdown);
  const progress = visual.ratio * 100;
  const disconnected = connection !== "connected";
  const twitchReconnecting = Boolean(challenge && state?.challengeSource === "live" &&
    (state.twitch.connection !== "connected" || state.twitch.subscription !== "enabled"));
  const idle = !challenge || challenge.phase === "idle";

  useEffect(() => {
    document.documentElement.classList.add("overlay-host");
    document.body.classList.add("overlay-host");
    return () => {
      document.documentElement.classList.remove("overlay-host");
      document.body.classList.remove("overlay-host");
    };
  }, []);

  useEffect(() => {
    try {
      const stored = window.localStorage.getItem("crowdquest.overlaySoundEnabled");
      if (stored === "true" || stored === "false") setSoundEnabled(stored === "true");
    } catch (error) {
      console.warn("Overlay sound preference could not be loaded.", error);
    }
  }, []);

  useEffect(() => {
    if (!challenge) return;
    const prior = previous.current;
    previous.current = { revision: challenge.revision, phase: challenge.phase, charge: challenge.charge };
    if (!prior || challenge.revision <= prior.revision || !soundEnabled) return;
    if (challenge.phase === "succeeded" && prior.phase !== "succeeded") {
      playOverlayCue("success");
      return;
    }
    const goal = challenge.config?.chargeGoal ?? 0;
    const previousTier = goal > 0 ? Math.floor(Math.min(1, prior.charge / goal) * 4) : 0;
    const currentTier = goal > 0 ? Math.floor(Math.min(1, challenge.charge / goal) * 4) : 0;
    if (challenge.phase === "active" && currentTier > previousTier) playOverlayCue("charge");
  }, [challenge?.revision, challenge?.phase, challenge?.charge, challenge?.config?.chargeGoal, soundEnabled]);

  const toggleSound = () => {
    const next = !soundEnabled;
    setSoundEnabled(next);
    if (next) unlockOverlayAudio();
    try {
      window.localStorage.setItem("crowdquest.overlaySoundEnabled", String(next));
    } catch (error) {
      console.warn("Overlay sound preference could not be saved.", error);
    }
  };

  return <main className="overlay-root" aria-label="CrowdQuest OBS overlay" data-overlay-mood={visual.mood} data-overlay-urgent={visual.mood === "urgent" ? "true" : "false"}>
    <button className="overlay-sound-toggle" type="button" onClick={toggleSound} aria-pressed={soundEnabled} title={soundEnabled ? "Mute overlay sounds" : "Enable overlay sounds"}>{soundEnabled ? "SOUND ON" : "SOUND OFF"}</button>
    <div className="overlay-safe-area">
      {(disconnected || twitchReconnecting) && <div className="overlay-connection" role="status"><i />
        {disconnected ? state ? "RECONNECTING TO QUEST" : "CONNECTING TO QUEST" : "TWITCH CHAT RECONNECTING"}
      </div>}
      {idle ? <section className="overlay-idle" data-overlay-mood={visual.mood}>
        <span className="overlay-brand"><b>CQ</b> CROWDQUEST <i>LIVE</i></span>
        <strong>Waiting for the next community quest</strong>
        <span>Chat will help write the rules.</span>
      </section> : <section className={`overlay-quest overlay-${challenge.phase}`} data-overlay-mood={visual.mood}>
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
            <div className="overlay-vote-track"><i style={{ transform: `scaleX(${voteRatio(challenge.voteCounts[candidate.id] ?? 0, challenge.voteCounts)})` }} /></div>
          </div>)}
          <span className="overlay-viewer-hint">VOTE IN CHAT · !VOTE A / B / C</span>
        </div>}
        {["active", "paused", "succeeded", "expired"].includes(challenge.phase) && <div className="overlay-progress" data-charge-milestone={visual.milestone} data-overlay-mood={visual.mood}>
          <div className="overlay-progress-heading"><span>{challenge.phase === "succeeded" ? "COMMUNITY SUCCESS" : challenge.phase === "expired" ? "TIME EXPIRED" : challenge.phase === "paused" ? "QUEST PAUSED" : "SHARED CHARGE"}</span><strong>{challenge.charge}<i> / {challenge.config?.chargeGoal ?? 0}</i></strong></div>
          <div className="overlay-progress-track" role="meter" aria-label="Community charge" aria-valuemin={0} aria-valuemax={challenge.config?.chargeGoal ?? 0} aria-valuenow={challenge.charge}><i style={{ transform: `scaleX(${progress / 100})` }} /></div>
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

function unlockOverlayAudio(): void {
  const Context = window.AudioContext;
  if (!Context) return;
  const context = new Context();
  void context.resume().then(() => context.close()).catch((error: unknown) => {
    console.warn("Overlay audio could not be enabled.", error);
    void context.close().catch((closeError: unknown) => console.warn("Overlay audio context could not close cleanly.", closeError));
  });
}

function playOverlayCue(type: "charge" | "success"): void {
  const Context = window.AudioContext;
  if (!Context) return;
  const context = new Context();
  const notes = type === "success" ? [660, 830, 1_050] : [500, 760];
  void context.resume().then(() => {
    const gain = context.createGain();
    gain.gain.setValueAtTime(0.0001, context.currentTime);
    gain.gain.exponentialRampToValueAtTime(type === "success" ? 0.12 : 0.08, context.currentTime + 0.025);
    gain.gain.exponentialRampToValueAtTime(0.0001, context.currentTime + (type === "success" ? 0.55 : 0.28));
    gain.connect(context.destination);
    let pendingNotes = notes.length;
    notes.forEach((frequency, index) => {
      const oscillator = context.createOscillator();
      oscillator.type = "sine";
      oscillator.frequency.value = frequency;
      oscillator.connect(gain);
      oscillator.onended = () => {
        pendingNotes -= 1;
        if (pendingNotes === 0) void context.close().catch((error: unknown) => console.warn("Overlay audio context could not close cleanly.", error));
      };
      oscillator.start(context.currentTime + index * 0.09);
      oscillator.stop(context.currentTime + (type === "success" ? 0.52 : 0.25));
    });
  }).catch((error: unknown) => {
    console.warn("Overlay audio could not start.", error);
    void context.close().catch((closeError: unknown) => console.warn("Overlay audio context could not close cleanly.", closeError));
  });
}

function voteRatio(count: number, counts: Record<string, number>): number {
  const total = Object.values(counts).reduce((sum, current) => sum + current, 0);
  return total === 0 ? 0 : count / total;
}

