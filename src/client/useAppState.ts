import { useEffect, useState } from "react";
import type { AppStateEnvelope, PublicAppState } from "./state.js";

export type RealtimeStatus = "connecting" | "connected" | "reconnecting";

export function useAppState() {
  const [state, setState] = useState<PublicAppState | null>(null);
  const [connection, setConnection] = useState<RealtimeStatus>("connecting");
  const [serverOffset, setServerOffset] = useState(0);
  const [clock, setClock] = useState(Date.now());

  useEffect(() => {
    let active = true;
    let socket: WebSocket | null = null;
    let retryTimer = 0;
    let heartbeatTimer = 0;
    let retry = 0;
    let lastServerMessageAt = Date.now();
    let lastSequence = 0;

    const connect = () => {
      if (!active) return;
      setConnection(retry === 0 ? "connecting" : "reconnecting");
      const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
      const current = new WebSocket(`${protocol}//${window.location.host}/ws/state`);
      socket = current;
      current.addEventListener("open", () => {
        if (!active) return;
        retry = 0;
        lastServerMessageAt = Date.now();
        setConnection("connected");
      });
      current.addEventListener("message", (event) => {
        if (!active || typeof event.data !== "string") return;
        try {
          const envelope = JSON.parse(event.data) as AppStateEnvelope;
          if (!Number.isSafeInteger(envelope.sequence) || typeof envelope.sentAt !== "number") return;
          lastServerMessageAt = Date.now();
          setServerOffset(envelope.sentAt - Date.now());
          if (envelope.type !== "heartbeat" && envelope.state && envelope.sequence >= lastSequence) {
            lastSequence = envelope.sequence;
            setState(envelope.state);
          }
        } catch {
          setConnection("reconnecting");
          current.close(1002, "Unreadable app state");
        }
      });
      current.addEventListener("close", () => {
        if (!active) return;
        setConnection("reconnecting");
        retry = Math.min(retry + 1, 5);
        const delay = Math.min(500 * (2 ** (retry - 1)), 8_000);
        retryTimer = window.setTimeout(connect, delay);
      });
      current.addEventListener("error", () => {
        if (active) current.close();
      });
    };

    connect();
    heartbeatTimer = window.setInterval(() => {
      setClock(Date.now());
      if (Date.now() - lastServerMessageAt > 25_000) socket?.close(4000, "App state is stale");
    }, 1_000);
    return () => {
      active = false;
      window.clearTimeout(retryTimer);
      window.clearInterval(heartbeatTimer);
      socket?.close(1000, "View closed");
    };
  }, []);

  return { state, connection, serverOffset, serverNow: clock + serverOffset };
}
