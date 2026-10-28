import { createServer } from "node:http";
import { once } from "node:events";
import { afterEach, describe, expect, it } from "vitest";
import WebSocket, { WebSocketServer } from "ws";
import { StateHub } from "./state-hub.js";
import { ChallengeRuntime } from "./challenge-runtime.js";
import { createPublicAppState } from "./app-state.js";
import { loadConfig } from "./config.js";
import { TwitchIntegration } from "./twitch-integration.js";
import type { ChallengeConfig } from "../src/domain/challenge.js";

const resources: Array<{ hub: { close(): Promise<void> }; server: ReturnType<typeof createServer> }> = [];

afterEach(async () => {
  for (const { hub, server } of resources.splice(0)) {
    await hub.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

async function createFixture() {
  const http = createServer();
  const sockets = new WebSocketServer({ noServer: true });
  let state = { revision: 1 };
  const hub = new StateHub(sockets, () => state);
  http.on("upgrade", (request, socket, head) => {
    sockets.handleUpgrade(request, socket, head, (client) => sockets.emit("connection", client, request));
  });
  await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve));
  const address = http.address();
  if (!address || typeof address === "string") throw new Error("Test WebSocket server did not bind.");
  resources.push({ hub, server: http });
  return {
    hub,
    setState: (next: { revision: number }) => { state = next; },
    url: `ws://127.0.0.1:${address.port}`,
  };
}

function nextMessage(socket: WebSocket): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Timed out waiting for state.")), 2_000);
    socket.once("message", (data) => {
      clearTimeout(timer);
      try { resolve(JSON.parse(data.toString()) as Record<string, unknown>); }
      catch { reject(new Error("State message was not valid JSON.")); }
    });
  });
}

describe("application state WebSocket", () => {
  it("sends an initial snapshot, broadcasts sanitized updates, and rejects client messages", async () => {
    const fixture = await createFixture();
    const socket = new WebSocket(`${fixture.url}/ws/state`);
    const initial = await nextMessage(socket);
    expect(initial).toMatchObject({ type: "snapshot", state: { revision: 1 } });

    fixture.setState({ revision: 2 });
    fixture.hub.broadcast();
    expect(await nextMessage(socket)).toMatchObject({ type: "update", state: { revision: 2 } });

    socket.send(JSON.stringify({ type: "action", broadcasterId: "untrusted" }));
    const [code] = await once(socket, "close") as [number];
    expect(code).toBe(1008);
  });

  it("sends the latest state again to a reconnecting client", async () => {
    const fixture = await createFixture();
    const first = new WebSocket(`${fixture.url}/ws/state`);
    await nextMessage(first);
    first.close();
    await once(first, "close");

    fixture.setState({ revision: 9 });
    const reconnected = new WebSocket(`${fixture.url}/ws/state`);
    expect(await nextMessage(reconnected)).toMatchObject({ type: "snapshot", state: { revision: 9 } });
    reconnected.close();
  });

  it("keeps the control room and overlay on identical authoritative challenge snapshots", async () => {
    const http = createServer();
    const sockets = new WebSocketServer({ noServer: true });
    const config = loadConfig({ PORT: "3000", SIMULATED_CHAT_ENABLED: "true" });
    let hub: StateHub<ReturnType<typeof createPublicAppState>> | null = null;
    let now = 10_000;
    const runtime = new ChallengeRuntime(() => hub?.broadcast(), () => now);
    const integration = new TwitchIntegration(config, () => runtime.state, () => {}, () => hub?.broadcast(), runtime.chat);
    hub = new StateHub(sockets, () => createPublicAppState(runtime, integration, config));
    http.on("upgrade", (request, socket, head) => {
      sockets.handleUpgrade(request, socket, head, (client) => sockets.emit("connection", client, request));
    });
    await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve));
    const address = http.address();
    if (!address || typeof address === "string") throw new Error("Test WebSocket server did not bind.");
    resources.push({ hub, server: http });

    const url = `ws://127.0.0.1:${address.port}/ws/state`;
    const controlRoom = new WebSocket(url);
    const overlay = new WebSocket(url);
    const [controlInitial, overlayInitial] = await Promise.all([nextMessage(controlRoom), nextMessage(overlay)]);
    expect(controlInitial.state).toEqual(overlayInitial.state);

    const challengeConfig: ChallengeConfig = {
      suggestionDurationMs: 10_000, votingDurationMs: 5_000, challengeDurationMs: 20_000, chargeGoal: 5, chargePerMessage: 1,
    };
    runtime.act({ streamerId: "local-simulation-operator", mode: "simulation" }, { type: "start-round", config: challengeConfig }, now);
    const [controlUpdate, overlayUpdate] = await Promise.all([nextMessage(controlRoom), nextMessage(overlay)]);
    expect(controlUpdate.state).toEqual(overlayUpdate.state);
    expect(controlUpdate.state).toMatchObject({ challenge: { phase: "suggestions" }, challengeSource: "simulated" });
    expect(JSON.stringify(controlUpdate)).not.toContain("refreshToken");
    controlRoom.close();
    overlay.close();
  });
});
