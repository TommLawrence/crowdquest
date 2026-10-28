import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { ConvexProvider, ConvexReactClient, useConvexConnectionState, useQuery } from "convex/react";
import { api } from "../../../convex/_generated/api.js";
import { Overlay, type OverlayLeaderboardEntry } from "../overlay/Overlay.js";
import { useAppState, type RealtimeStatus } from "../useAppState.js";
import type { Candidate, PublicAppState, PublicOverlayState, TwitchStatus } from "../state.js";

interface AppStateValue { state: PublicAppState | null; connection: RealtimeStatus; serverNow: number }
const AppStateContext = createContext<AppStateValue | null>(null);
const convexUrl = import.meta.env.VITE_CONVEX_URL?.trim();
const convexClient = convexUrl ? new ConvexReactClient(convexUrl) : null;
const twitchConnectPath = convexClient ? "/api/twitch/connect" : "/auth/twitch/connect";

const INITIAL_CONFIG = {
  suggestionDurationMs: 120_000,
  votingDurationMs: 60_000,
  challengeDurationMs: 300_000,
  chargeGoal: 50,
  chargePerMessage: 1,
};

export function App() {
  const views = <AppViews />;
  return convexClient
    ? <ConvexProvider client={convexClient}><ConvexStateProvider>{views}</ConvexStateProvider></ConvexProvider>
    : <LocalStateProvider>{views}</LocalStateProvider>;
}

function AppViews() {
  if (window.location.pathname === "/overlay") return convexClient ? <ConvexOverlayView /> : <OverlayView />;
  return convexClient ? <ConvexControlRoom /> : <ControlRoom />;
}

function LocalStateProvider({ children }: { children: ReactNode }) {
  const value = useAppState();
  return <AppStateContext.Provider value={value}>{children}</AppStateContext.Provider>;
}

function ConvexStateProvider({ children }: { children: ReactNode }) {
  const convexConnection = useConvexConnectionState();
  const [clock, setClock] = useState(Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setClock(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, []);
  const value: AppStateValue = {
    state: null,
    connection: convexConnection.isWebSocketConnected ? "connected" : convexConnection.hasEverConnected ? "reconnecting" : "connecting",
    serverNow: clock,
  };
  return <AppStateContext.Provider value={value}>{children}</AppStateContext.Provider>;
}

function ConvexControlRoom() {
  const result = useQuery(api.state.publicState, {}) as PublicAppState | undefined;
  const value = useCurrentAppState();
  return <AppStateContext.Provider value={{ ...value, state: result ?? null }}><ControlRoom /></AppStateContext.Provider>;
}

function ConvexOverlayView() {
  const state = useQuery(api.state.publicOverlayState, {}) as PublicOverlayState | undefined;
  const leaderboard = useQuery(api.state.publicLeaderboard, {}) as OverlayLeaderboardEntry[] | undefined;
  const { connection, serverNow } = useCurrentAppState();
  return <Overlay state={state ?? null} connection={connection} serverNow={serverNow} leaderboard={leaderboard ?? []} />;
}

function useCurrentAppState() {
  const value = useContext(AppStateContext);
  if (!value) throw new Error("The application state provider is missing.");
  return value;
}

interface SimulationStatus { enabled: boolean; active: boolean }

function ControlRoom() {
  const { state, connection, serverNow } = useCurrentAppState();
  const [status, setStatus] = useState<TwitchStatus | null>(null);
  const [simulationStatus, setSimulationStatus] = useState<SimulationStatus | null>(null);
  const [controlSource, setControlSource] = useState<"live" | "simulated">("live");
  const [requestError, setRequestError] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [config, setConfig] = useState(INITIAL_CONFIG);
  const [selected, setSelected] = useState<string[]>([]);
  const [idea, setIdea] = useState("");
  const [viewerSlot, setViewerSlot] = useState(1);
  const pendingRef = useRef(false);

  const refreshStatus = useCallback(async () => {
    try {
      const response = await fetch("/api/twitch/status", { cache: "no-store" });
      if (!response.ok) throw new Error("Could not load Twitch status.");
      setStatus(await response.json() as TwitchStatus);
      const simulationResponse = await fetch("/api/simulation/status", { cache: "no-store" });
      if (simulationResponse.ok) setSimulationStatus(await simulationResponse.json() as SimulationStatus);
      setRequestError(null);
    } catch {
      setRequestError("The control room could not refresh the server status. Check the connection and retry.");
    }
  }, []);

  useEffect(() => {
    void refreshStatus();
    const timer = window.setInterval(() => void refreshStatus(), 15_000);
    return () => window.clearInterval(timer);
  }, [refreshStatus]);

  useEffect(() => {
    if (state?.challengeSource) setControlSource(state.challengeSource);
  }, [state?.challengeSource]);

  const challenge = state?.challenge;
  const sourceMatchesRound = !state?.challengeSource || state.challengeSource === (controlSource === "simulated" ? "simulated" : "live");
  const canControl = sourceMatchesRound && (controlSource === "simulated" ? Boolean(simulationStatus?.active) : Boolean(status?.authenticatedSession));
  const simulationSession = Boolean(simulationStatus?.active);
  const demoMode = simulationSession || state?.challengeSource === "simulated";
  const liveTwitchVerified = Boolean(status?.authenticatedSession && status.eventSub.connection === "connected" && status.eventSub.subscription === "enabled" && status.messagesReceived > 0);
  const activeModifier = challenge?.candidates.find((candidate) => candidate.id === challenge.winningCandidateId) ?? null;

  const postJson = async (path: string, body: unknown): Promise<Record<string, unknown>> => {
    const response = await fetch(path, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    const result = await response.json() as Record<string, unknown>;
    if (!response.ok) throw new Error(typeof result.message === "string" ? result.message : typeof result.error === "string" ? result.error : "The server rejected that action.");
    return result;
  };

  const act = async (action: Record<string, unknown>, success: string) => {
    if (pendingRef.current) return;
    pendingRef.current = true;
    setPending(true);
    setRequestError(null);
    setFeedback(null);
    try {
      await postJson(controlSource === "simulated" ? "/api/simulation/action" : "/api/challenge/action", action);
      setFeedback(success);
    } catch (error) {
      setRequestError(error instanceof Error ? error.message : "The challenge action could not be completed.");
    } finally {
      pendingRef.current = false;
      setPending(false);
    }
  };

  const startRound = () => act({ type: "start-round", config: {
    suggestionDurationMs: Math.round(config.suggestionDurationMs),
    votingDurationMs: Math.round(config.votingDurationMs),
    challengeDurationMs: Math.round(config.challengeDurationMs),
    chargeGoal: Math.round(config.chargeGoal),
    chargePerMessage: Math.round(config.chargePerMessage),
  } }, "Suggestion round started.");

  const startSimulationSession = async () => {
    if (pendingRef.current) return;
    pendingRef.current = true;
    setPending(true);
    setRequestError(null);
    try {
      await postJson("/api/simulation/session", {});
      await refreshStatus();
      setControlSource("simulated");
      setFeedback("Demo controls are ready. Activity is local and separate from Twitch chat.");
    } catch (error) {
      setRequestError(error instanceof Error ? error.message : "Local simulation could not start.");
    } finally {
      pendingRef.current = false;
      setPending(false);
    }
  };

  const sendDemo = async (text: string) => {
    if (pendingRef.current) return;
    pendingRef.current = true;
    setPending(true);
    setRequestError(null);
    setFeedback(null);
    try {
      await postJson("/api/simulation/message", { text, viewerSlot });
      setFeedback(`Demo viewer ${viewerSlot} sent ${text.split(/\s/)[0]}.`);
      if (text.startsWith("!suggest")) setIdea("");
    } catch (error) {
      setRequestError(error instanceof Error ? error.message : "The demo chat command could not be sent.");
    } finally {
      pendingRef.current = false;
      setPending(false);
    }
  };

  const toggleSuggestion = (id: string) => {
    setSelected((current) => current.includes(id)
      ? current.filter((item) => item !== id)
      : current.length < 3 ? [...current, id] : current);
  };

  const candidateForSuggestion = new Map((challenge?.candidates ?? []).map((candidate) => [candidate.suggestionId, candidate]));
  const voteIsTied = challenge?.candidates.length
    ? new Set(challenge.candidates.map((candidate) => challenge.voteCounts[candidate.id] ?? 0)).size < challenge.candidates.length
      && challenge.candidates.filter((candidate) => (challenge.voteCounts[candidate.id] ?? 0) === Math.max(...challenge.candidates.map((candidate) => challenge.voteCounts[candidate.id] ?? 0))).length > 1
    : false;

  const secondsRemaining = challenge?.phase === "paused"
    ? challenge.pausedRemainingMs === null ? null : Math.ceil(challenge.pausedRemainingMs / 1_000)
    : challenge?.phaseEndsAt === null || !challenge ? null : Math.max(0, Math.ceil((challenge.phaseEndsAt - serverNow) / 1_000));

  return (
    <main className="control-shell">
      <header className="topbar">
        <a className="brand" href="/" aria-label="CrowdQuest Live home">
          <span className="brand-mark" aria-hidden="true">CQ</span>
          <span>CROWDQUEST <span className="brand-light">LIVE</span></span>
        </a>
        <div className="topbar-right">
          <a className="overlay-link" href="/overlay" target="_blank" rel="noreferrer">Open OBS overlay <span aria-hidden="true">↗</span></a>
          {demoMode && <span className="sim-session-pill">DEMO MODE</span>}
          {liveTwitchVerified && <span className="eventsub-pill pill-live live-twitch-pill"><i aria-hidden="true" />LIVE TWITCH</span>}
          <div className="connection-status">
            <span className={`status-dot ${connection === "connected" ? "is-connected" : "is-reconnecting"}`} aria-hidden="true" />
            <span>{connection === "connected" ? "STATE SYNCED" : "STATE RECONNECTING"}</span>
          </div>
        </div>
      </header>

      <section className="stream-row" aria-label="Twitch connection">
        <div className="stream-mark" aria-hidden="true">◎</div>
        <div className="stream-copy">
          <span className="micro-label">CHANNEL CONNECTION</span>
          <strong>{status?.broadcaster?.displayName ?? (status?.authorized ? "Streamer session needs reconnect" : "No broadcaster connected")}</strong>
          <span className="stream-subline">{status?.broadcaster ? `@${status.broadcaster.login}` : status?.authorized ? "Saved Twitch authorization · browser session required" : "Read-only chat access"}</span>
        </div>
        <span className={`eventsub-pill ${status?.eventSub.connection === "connected" && status.eventSub.subscription === "enabled" ? "pill-live" : ""}`}>
          <i aria-hidden="true" />
          {`${status?.eventSub.connection ?? "checking"} · ${status?.eventSub.subscription ?? "none"}`}
        </span>
        {status?.authenticatedSession && <button className="link-button" type="button" disabled={pending} onClick={async () => {
          if (pendingRef.current) return;
          pendingRef.current = true;
          setPending(true);
          try {
            const response = await fetch("/api/twitch/disconnect", { method: "POST" });
            if (!response.ok) throw new Error("Disconnect was rejected.");
            await refreshStatus();
            setFeedback("Twitch disconnected.");
          } catch { setRequestError("Twitch could not be disconnected. Retry after checking the server connection."); }
          finally { pendingRef.current = false; setPending(false); }
        }}>Disconnect</button>}
        {!status?.authenticatedSession && status?.configured && <a className="small-action" href={twitchConnectPath}>{status.authorized ? "Restore streamer session" : "Connect Twitch"}</a>}
        {convexClient && status?.authenticatedSession && !status.chatReader && <a className="small-action" href="/api/twitch/bot/connect">Connect chat reader</a>}
      </section>

      {(status?.eventSub.error || status?.error) && !simulationSession && (
        <div className="notice notice-warn" role="status">
          <span className="notice-mark" aria-hidden="true">!</span>
          <span>{status.eventSub.error ?? status.error}</span>
          {status.configured && !status.authorized && <a href={twitchConnectPath}>Reconnect</a>}
        </div>
      )}
      {requestError && <div className="notice notice-error" role="alert">{requestError}</div>}
      {feedback && <div className="notice notice-success" role="status">{feedback}</div>}

      <section className="page-heading">
        <div>
          <p className="eyebrow">STREAMER CONTROL ROOM <span className="eyebrow-dot">/</span> REAL-TIME STATE</p>
          <h1>Give chat a <em>quest.</em></h1>
          <p className="heading-copy">Your community shapes the challenge. You stay in control of the game.</p>
        </div>
        <div className="stage-chip">
          <span className="stage-chip-label">CURRENT STAGE</span>
          <strong>{challenge ? phaseName(challenge.phase) : "Syncing"}</strong>
        </div>
      </section>

      <div className="control-grid">
        <section className={`quest-panel panel panel-${challenge?.phase ?? "loading"}`} aria-labelledby="quest-title">
          <div className="panel-topline">
            <div><span className="panel-index">01</span><span className="micro-label">CHALLENGE ENGINE</span></div>
            <span className={`phase-tag phase-${challenge?.phase ?? "loading"}`}>{challenge ? phaseName(challenge.phase) : "Connecting"}</span>
          </div>
          <div className="quest-main">
            <div className="quest-title-wrap">
              <span className="micro-label">COMMUNITY CHALLENGE</span>
              <h2 id="quest-title">{activeModifier?.text ?? (challenge?.phase === "idle" ? "Your next quest starts with chat." : "Choose the next modifier.")}</h2>
              {activeModifier && <p className="modifier-line">Winning modifier · option {activeModifier.label}</p>}
            </div>
            <div className="countdown" aria-label={secondsRemaining === null ? undefined : `${secondsRemaining} seconds remaining`}>
              <strong>{formatCountdown(secondsRemaining)}</strong>
              <span>{challenge?.phase === "paused" ? "PAUSED" : challenge?.phaseEndsAt === null ? "NO TIMER" : "TIME LEFT"}</span>
            </div>
          </div>

          <div className="meter-head">
            <span>SHARED CHARGE</span>
            <strong>{challenge?.charge ?? 0}<small> / {challenge?.config?.chargeGoal ?? "—"}</small></strong>
          </div>
          <div className="progress-track" role="progressbar" aria-label="Shared challenge progress" aria-valuemin={0} aria-valuemax={challenge?.config?.chargeGoal ?? 1} aria-valuenow={challenge?.charge ?? 0}>
            <div className="progress-fill" style={{ width: `${challenge?.config ? Math.min(100, challenge.charge / challenge.config.chargeGoal * 100) : 0}%` }} />
          </div>
          <div className="meter-foot">
            <span>{challenge?.contributionCount ?? 0} contributions</span>
            <span>{challenge?.config ? `${challenge.config.chargePerMessage} charge per !charge` : "Set the goal when you start"}</span>
          </div>

          <div className="quest-controls">
            {state?.simulatedChatEnabled && <div className="mode-selector" aria-label="Challenge control source">
              <span>CONTROL SOURCE</span>
              <button type="button" className={controlSource === "live" ? "mode-selected" : ""} aria-pressed={controlSource === "live"} disabled={!status?.authenticatedSession} onClick={() => setControlSource("live")}>LIVE TWITCH</button>
              <button type="button" className={controlSource === "simulated" ? "mode-selected mode-simulated" : ""} aria-pressed={controlSource === "simulated"} disabled={!simulationSession} onClick={() => setControlSource("simulated")}>DEMO</button>
              <p>Demo activity is generated locally and never received from Twitch.</p>
            </div>}
            {challenge?.phase === "idle" && <>
              <div className="config-fields">
                <label>Suggestion window <span>seconds</span><input type="number" min={5} max={3600} value={Math.round(config.suggestionDurationMs / 1000)} onChange={(event) => setConfig({ ...config, suggestionDurationMs: Number(event.target.value) * 1000 })} /></label>
                <label>Vote window <span>seconds</span><input type="number" min={5} max={3600} value={Math.round(config.votingDurationMs / 1000)} onChange={(event) => setConfig({ ...config, votingDurationMs: Number(event.target.value) * 1000 })} /></label>
                <label>Quest time <span>seconds</span><input type="number" min={5} max={3600} value={Math.round(config.challengeDurationMs / 1000)} onChange={(event) => setConfig({ ...config, challengeDurationMs: Number(event.target.value) * 1000 })} /></label>
                <label>Charge goal <span>points</span><input type="number" min={1} max={1000000} value={config.chargeGoal} onChange={(event) => setConfig({ ...config, chargeGoal: Number(event.target.value) })} /></label>
                <label>Per !charge <span>points</span><input type="number" min={1} max={100} value={config.chargePerMessage} onChange={(event) => setConfig({ ...config, chargePerMessage: Number(event.target.value) })} /></label>
              </div>
              <button className="primary-action" type="button" disabled={pending || !canControl || !challenge} onClick={() => void startRound()}>
                Start suggestion round <span aria-hidden="true">↗</span>
              </button>
              {!canControl && <p className="control-hint">Connect Twitch for live controls, or start a local demo below.</p>}
            </>}
            {challenge && ["suggestions", "voting", "active"].includes(challenge.phase) && <button className="secondary-action" disabled={pending || !canControl} onClick={() => void act({ type: "pause" }, "Challenge paused.")}>Pause challenge</button>}
            {challenge?.phase === "paused" && <button className="primary-action" disabled={pending || !canControl} onClick={() => void act({ type: "resume" }, "Challenge resumed.")}>Resume challenge <span aria-hidden="true">↗</span></button>}
            {challenge && !["idle", "succeeded", "expired", "cancelled"].includes(challenge.phase) && <button className="text-action danger-action" disabled={pending || !canControl} onClick={() => void act({ type: "cancel" }, "Challenge cancelled.")}>Cancel challenge</button>}
            {challenge && <button className="text-action" disabled={pending || !canControl || challenge.phase === "idle"} onClick={() => void act({ type: "reset" }, "Challenge reset.")}>Reset round</button>}
            {challenge?.phase === "review" && <div className="transition-note">Select up to three ideas, then approve to open voting. The vote closes automatically when its timer expires.</div>}
            {challenge?.phase === "voting" && <div className="transition-note">Voting closes on the server timer. A tied vote goes to the option approved first.</div>}
            {challenge && !sourceMatchesRound && <div className="transition-note">This round belongs to {state?.challengeSource === "simulated" ? "Demo" : "Live Twitch"}. Switch control source to match it before making changes.</div>}
            {challenge?.phase === "succeeded" && <div className="result-line result-success"><span>✦</span> Goal reached — the community completed the quest.</div>}
            {challenge?.phase === "expired" && <div className="result-line result-expired"><span>◷</span> Time expired before the goal was reached.</div>}
            {challenge?.phase === "cancelled" && <div className="result-line">Round cancelled. Reset when you’re ready to start again.</div>}
          </div>
          <div className="engine-footnote"><span className="live-pip" /> Server-authoritative timer <span className="footnote-divider">·</span> Commands are checked by the challenge engine</div>
        </section>

        <section className="ideas-panel panel" aria-labelledby="ideas-title">
          <div className="panel-topline">
            <div><span className="panel-index">02</span><span className="micro-label">COMMUNITY INPUT</span></div>
            <span className="subtle-count">{challenge?.suggestions.length ?? 0} SUBMISSIONS</span>
          </div>
          <div className="section-title-line">
            <div><h2 id="ideas-title">Ideas from chat</h2><p>Viewer suggestions, ready for your review.</p></div>
            {challenge?.phase === "review" && <span className="selected-count">{selected.length}/3 selected</span>}
          </div>
          {challenge && challenge.suggestions.length ? <div className="idea-list">
            {challenge.suggestions.map((suggestion, index) => {
              const candidate = candidateForSuggestion.get(suggestion.id);
              const metadata = state?.suggestionMetadata[suggestion.id];
              const isSelected = selected.includes(suggestion.id);
              const decided = ["voting", "active", "paused", "succeeded", "expired", "cancelled"].includes(challenge.phase);
              return <label key={suggestion.id} className={`idea-row${isSelected ? " idea-selected" : ""}`}>
                {challenge.phase === "review" && <input type="checkbox" checked={isSelected} disabled={pending || (!isSelected && selected.length >= 3)} onChange={() => toggleSuggestion(suggestion.id)} aria-label={`Select idea: ${suggestion.text}`} />}
                <span className="idea-order">{String(index + 1).padStart(2, "0")}</span>
                <span className="idea-copy"><strong>{suggestion.text}</strong><small>{metadata?.actor ?? "Viewer"} · {relativeTime(suggestion.submittedAt)}</small></span>
                {candidate && <span className="idea-status approved">{candidate.label} · APPROVED</span>}
                {!candidate && decided && <span className="idea-status">NOT SELECTED</span>}
                {!candidate && challenge.phase === "review" && <span className="idea-status">{isSelected ? "SELECTED" : "AWAITING REVIEW"}</span>}
                {!candidate && !decided && challenge.phase !== "review" && <span className="idea-status">RECEIVED</span>}
              </label>;
            })}
          </div> : <div className="empty-state"><span className="empty-glyph">↳</span><strong>No ideas yet</strong><span>When a round opens, viewers can submit with <code>!suggest your idea</code>.</span></div>}
          {challenge?.phase === "review" && <div className="review-footer">
            <span>Anything left unselected is declined for this round.</span>
            <button className="small-action" disabled={pending || !canControl || selected.length === 0 || selected.length > 3} onClick={() => void act({ type: "approve-candidates", suggestionIds: selected }, `Approved ${selected.length} idea${selected.length === 1 ? "" : "s"}; voting is open.`)}>
              Approve &amp; open vote <span aria-hidden="true">→</span>
            </button>
          </div>}
        </section>

        <section className="vote-panel panel" aria-labelledby="vote-title">
          <div className="panel-topline">
            <div><span className="panel-index">03</span><span className="micro-label">COMMUNITY VOTE</span></div>
            {challenge?.phase === "voting" && <span className="vote-open"><i /> VOTING OPEN</span>}
          </div>
          <div className="section-title-line"><div><h2 id="vote-title">Choose the modifier</h2><p>One vote per viewer · <code>!vote A</code></p></div></div>
          {challenge?.candidates.length ? <div className="candidate-list">
            {challenge.candidates.map((candidate) => <CandidateRow key={candidate.id} candidate={candidate} count={challenge.voteCounts[candidate.id] ?? 0} total={Object.values(challenge.voteCounts).reduce((sum, count) => sum + count, 0)} winner={activeModifier?.id === candidate.id} />)}
          </div> : <div className="empty-inline">Approved ideas will appear here as voting options.</div>}
          {challenge?.phase === "voting" && <div className="vote-footnote">{voteIsTied ? "The leading options are tied. " : ""}Ties resolve to the first approved option when the server timer closes voting.</div>}
          {activeModifier && <div className="winner-banner"><span>WINNING MODIFIER</span><strong>{activeModifier.label} <b>{activeModifier.text}</b></strong></div>}
        </section>

        <section className="activity-panel panel" aria-labelledby="activity-title">
          <div className="panel-topline"><div><span className="panel-index">04</span><span className="micro-label">ACTIVITY</span></div><span className="subtle-count">{state?.chat.messagesReceived ?? 0} LIVE COMMANDS</span></div>
          <div className="section-title-line"><div><h2 id="activity-title">Recent chat activity</h2><p>Commands only · no general chat text stored.</p></div></div>
          {state?.activity.length ? <ul className="activity-list">
            {state.activity.slice(0, 7).map((item) => <li key={item.id}>
              <time>{new Date(item.at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</time>
              {item.source === "simulated" && <span className="sim-tag">DEMO</span>}
              <span className="activity-actor">{item.actor}</span>
              <span className="activity-event"><b>!{item.command}</b>{item.detail ? ` · ${item.detail}` : ""}</span>
              <span className={item.outcome === "accepted" ? "activity-result accepted" : "activity-result"}>{item.outcome}</span>
            </li>)}
          </ul> : <div className="empty-inline">Accepted and rejected commands will appear here.</div>}
          <div className="activity-counts"><span>Live Twitch <b>{state?.chat.messagesReceived ?? 0}</b></span><span className="sim-count">Demo <b>{state?.chat.simulatedMessagesReceived ?? 0}</b></span></div>
        </section>
      </div>

      <section className="command-strip" aria-label="Viewer instructions">
        <div><span className="micro-label">TELL YOUR VIEWERS</span><strong>Chat writes the rules. You play the game.</strong></div>
        <code><b>!suggest</b> idea</code><code><b>!vote</b> A</code><code><b>!charge</b></code>
      </section>

      {state?.simulatedChatEnabled && <section className="simulation-panel panel" aria-labelledby="simulation-title">
        <div className="panel-topline"><div><span className="panel-index">DEV</span><span className="micro-label">OFFLINE PREVIEW</span></div></div>
        <div className="simulation-intro"><div><h2 id="simulation-title">Demo chat</h2><p>Creates local test events through the same command parser and challenge engine. It never represents Twitch viewers.</p></div>
          {!simulationSession && <button className="secondary-action" disabled={pending} onClick={() => void startSimulationSession()}>Start local demo</button>}
        </div>
        {simulationSession && <div className="sim-controls">
          <label className="sim-viewer-select">Test viewer<select value={viewerSlot} onChange={(event) => setViewerSlot(Number(event.target.value))}>{[1, 2, 3, 4, 5].map((slot) => <option key={slot} value={slot}>Demo Viewer {slot}</option>)}</select></label>
          <div className="sim-suggest"><label htmlFor="sim-idea">Try a suggestion</label><div><input id="sim-idea" maxLength={120} placeholder="e.g. No jumping" value={idea} onChange={(event) => setIdea(event.target.value)} /><button disabled={pending || !idea.trim()} onClick={() => void sendDemo(`!suggest ${idea.trim()}`)}>Send !suggest</button></div></div>
          <div className="sim-votes"><span>Cast a vote</span><div>{(["A", "B", "C"] as const).map((label) => <button key={label} disabled={pending} onClick={() => void sendDemo(`!vote ${label}`)}>!vote {label}</button>)}</div></div>
          <button className="sim-charge" disabled={pending} onClick={() => void sendDemo("!charge")}>Send !charge <span aria-hidden="true">↗</span></button>
        </div>}
      </section>}

      <footer className="shell-footer"><span>STREAMER CONTROLLED <i /> READ-ONLY TWITCH CHAT</span><span>OBS overlay is public and read-only · challenge timers run on this server</span></footer>
    </main>
  );
}

function CandidateRow({ candidate, count, total, winner }: { candidate: Candidate; count: number; total: number; winner: boolean }) {
  const width = total === 0 ? 0 : count / total * 100;
  return <div className={`candidate-row${winner ? " candidate-winner" : ""}`}>
    <div className="candidate-heading"><span className="candidate-label">{candidate.label}</span><strong>{candidate.text}</strong><span className="vote-count">{count} <small>{count === 1 ? "VOTE" : "VOTES"}</small></span></div>
    <div className="candidate-track"><div style={{ width: `${width}%` }} /></div>
    {winner && <span className="candidate-winner-tag">WINNER</span>}
  </div>;
}

function OverlayView() {
  const { state, connection, serverNow } = useCurrentAppState();
  useEffect(() => {
    document.documentElement.classList.add("overlay-host");
    document.body.classList.add("overlay-host");
    return () => {
      document.documentElement.classList.remove("overlay-host");
      document.body.classList.remove("overlay-host");
    };
  }, []);
  return <Overlay state={state} connection={connection} serverNow={serverNow} />;
}

function phaseName(phase: string): string {
  const names: Record<string, string> = { idle: "Ready", suggestions: "Collecting ideas", review: "Review ideas", voting: "Voting", active: "Quest active", paused: "Paused", succeeded: "Quest complete", expired: "Time expired", cancelled: "Cancelled" };
  return names[phase] ?? phase;
}

function formatCountdown(seconds: number | null): string {
  if (seconds === null) return "—:—";
  return `${Math.floor(seconds / 60).toString().padStart(2, "0")}:${(seconds % 60).toString().padStart(2, "0")}`;
}

function relativeTime(timestamp: number): string {
  const seconds = Math.max(0, Math.floor((Date.now() - timestamp) / 1_000));
  if (seconds < 60) return `${seconds}s ago`;
  return `${Math.floor(seconds / 60)}m ago`;
}

