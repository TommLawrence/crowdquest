import { useEffect, useState } from "react";
import { Overlay } from "../overlay/Overlay.js";
import {
  advanceDemoScript,
  createDemoRound,
  restartDemoRound,
  sendDemoCommand,
  tickDemoRound,
  toDemoOverlayState,
  type DemoRound,
} from "./round.js";
import "./DemoPage.css";

export function DemoPage() {
  const [round, setRound] = useState<DemoRound>(() => createDemoRound());
  const [autoplay, setAutoplay] = useState(false);
  const [clock, setClock] = useState(Date.now());

  useEffect(() => {
    const timer = window.setInterval(() => {
      const now = Date.now();
      setClock(now);
      setRound((current) => tickDemoRound(current, now));
    }, 1_000);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    if (!autoplay) return;
    if (round.scriptStep === "done") {
      setAutoplay(false);
      return;
    }
    const timer = window.setTimeout(() => setRound((current) => advanceDemoScript(current)), 650);
    return () => window.clearTimeout(timer);
  }, [autoplay, round.scriptStep]);

  const restart = () => {
    setAutoplay(false);
    setRound((current) => restartDemoRound(current));
  };
  const send = (message: string, viewer: string) => {
    setAutoplay(false);
    setRound((current) => sendDemoCommand(current, message, viewer));
  };
  const overlayState = toDemoOverlayState(round.challenge);

  return <main className="demo-page">
    <div className="demo-scene" aria-label="CrowdQuest Live overlay demo">
      <Overlay state={overlayState} connection="connected" serverNow={Math.max(clock, round.now)} />
    </div>
    <section className="demo-strip" aria-label="Demo controls">
      <div className="demo-strip-heading">
        <span className="demo-mode-label"><i aria-hidden="true" />Demo; simulated chat</span>
        <p>Local activity only · no Twitch connection</p>
      </div>
      <div className="demo-strip-actions">
        <button className="demo-restart" type="button" onClick={restart}>Start / restart round</button>
        <button type="button" disabled={round.challenge.phase !== "suggestions"} onClick={() => send("!suggest No jumping", `demo-viewer-${round.challenge.suggestions.length + 1}`)}>!suggest</button>
        <span className="demo-action-group" aria-label="Send a vote">
          {(["A", "B", "C"] as const).map((label) => <button key={label} type="button" disabled={round.challenge.phase !== "voting"} onClick={() => send(`!vote ${label}`, `demo-voter-${label}`)}>{`!vote ${label}`}</button>)}
        </span>
        <button type="button" disabled={round.challenge.phase !== "active"} onClick={() => send("!charge", `demo-charger-${round.challenge.contributionCount + 1}`)}>!charge</button>
        <button className="demo-autoplay" type="button" disabled={autoplay || round.challenge.phase === "succeeded"} onClick={() => { setRound(createDemoRound()); setAutoplay(true); }}>Auto-play full round</button>
      </div>
      <p className="demo-feedback" role="status" aria-live="polite">{round.feedback}</p>
    </section>
  </main>;
}
