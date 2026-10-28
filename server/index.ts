import { createServer } from "node:http";
import { WebSocketServer } from "ws";
import { createServer as createViteServer } from "vite";
import { createPublicAppState } from "./app-state.js";
import { ChallengeRuntime } from "./challenge-runtime.js";
import { loadConfig } from "./config.js";
import { createHttpHandler } from "./http-app.js";
import { StateHub } from "./state-hub.js";
import { TwitchIntegration } from "./twitch-integration.js";

const config = loadConfig(process.env);

async function startServer(): Promise<void> {
  const vite = await createViteServer({
    configFile: "vite.config.ts",
    server: { middlewareMode: true },
    appType: "spa",
  });

  let hub: StateHub<ReturnType<typeof createPublicAppState>> | null = null;
  const notifyState = (): void => hub?.broadcast();
  const runtime = new ChallengeRuntime(notifyState);
  const integration = new TwitchIntegration(config, () => runtime.state, () => {}, notifyState, runtime.chat);
  const webSockets = new WebSocketServer({ noServer: true, maxPayload: 1_024, perMessageDeflate: false });
  hub = new StateHub(webSockets, () => createPublicAppState(runtime, integration, config));
  const httpHandler = createHttpHandler(
    config,
    integration,
    runtime,
    () => createPublicAppState(runtime, integration, config),
  );

  const server = createServer((request, response) => {
    void httpHandler(request, response).then((handled) => {
      if (handled) return;
      vite.middlewares(request, response, () => {
        if (!response.writableEnded) {
          response.writeHead(404, { "content-type": "application/json; charset=utf-8" });
          response.end(JSON.stringify({ error: "Not found" }));
        }
      });
    }).catch((error: unknown) => {
      console.error("Request dispatch failed.", error instanceof Error ? error.name : "UnknownError");
      if (!response.headersSent) {
        response.writeHead(500, { "content-type": "application/json; charset=utf-8" });
        response.end(JSON.stringify({ error: "The request could not be completed." }));
      } else {
        response.end();
      }
    });
  });

  server.on("upgrade", (request, socket, head) => {
    let path: string;
    try {
      path = new URL(request.url ?? "/", "http://localhost").pathname;
    } catch {
      socket.destroy();
      return;
    }
    if (path !== "/ws/state") {
      socket.destroy();
      return;
    }
    webSockets.handleUpgrade(request, socket, head, (client) => {
      webSockets.emit("connection", client, request);
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(config.port, config.host, () => {
      server.off("error", reject);
      resolve();
    });
  });

  const timer = setInterval(() => runtime.advance(Date.now()), 250);
  const heartbeat = setInterval(() => hub?.heartbeat(), 10_000);

  console.info(`CrowdQuest Live listening on http://${config.host}:${config.port}`);
  void integration.initialize().catch((error: unknown) => {
    console.error("Twitch integration startup failed.", error instanceof Error ? error.name : "UnknownError");
  });

  const shutdown = (): void => {
    clearInterval(timer);
    clearInterval(heartbeat);
    runtime.chat.stop();
    void integration.stop().catch((error: unknown) => {
      console.error("Twitch integration shutdown failed.", error instanceof Error ? error.name : "UnknownError");
      process.exitCode = 1;
    });
    void hub?.close().catch((error: unknown) => {
      console.error("State WebSocket shutdown failed.", error instanceof Error ? error.name : "UnknownError");
      process.exitCode = 1;
    });
    server.close((error) => {
      if (error) {
        console.error("Server shutdown failed.", error);
        process.exitCode = 1;
      }
      void vite.close().catch((closeError: unknown) => {
        console.error("Vite shutdown failed.", closeError instanceof Error ? closeError.name : "UnknownError");
        process.exitCode = 1;
      });
    });
  };

  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
}

startServer().catch((error: unknown) => {
  console.error("Unable to start CrowdQuest Live.", error instanceof Error ? error.name : "UnknownError");
  process.exitCode = 1;
});
