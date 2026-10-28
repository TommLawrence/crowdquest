import WebSocket, { type WebSocketServer } from "ws";

export interface StateEnvelope<T> {
  type: "snapshot" | "update";
  sequence: number;
  sentAt: number;
  state: T;
}

const MAX_CLIENTS = 100;

export class StateHub<T> {
  private readonly clients = new Set<WebSocket>();
  private sequence = 0;

  constructor(private readonly server: WebSocketServer, private readonly getState: () => T) {
    server.on("connection", (socket) => this.attach(socket));
  }

  broadcast(): void {
    const envelope = this.createEnvelope("update");
    const encoded = JSON.stringify(envelope);
    for (const client of this.clients) {
      if (client.readyState !== WebSocket.OPEN) continue;
      try {
        client.send(encoded, (error) => {
          if (error) client.terminate();
        });
      } catch {
        client.terminate();
      }
    }
  }

  heartbeat(): void {
    const encoded = JSON.stringify({ type: "heartbeat", sequence: this.sequence, sentAt: Date.now() });
    for (const client of this.clients) {
      if (client.readyState !== WebSocket.OPEN) continue;
      try {
        client.send(encoded, (error) => {
          if (error) client.terminate();
        });
      } catch {
        client.terminate();
      }
    }
  }

  close(): Promise<void> {
    for (const client of this.clients) client.close(1001, "Server shutting down");
    this.clients.clear();
    return new Promise((resolve, reject) => {
      this.server.close((error) => error ? reject(error) : resolve());
    });
  }

  private attach(socket: WebSocket): void {
    if (this.clients.size >= MAX_CLIENTS) {
      socket.close(1013, "Too many state clients");
      return;
    }
    this.clients.add(socket);
    socket.on("message", () => socket.close(1008, "State stream is read-only"));
    socket.on("close", () => this.clients.delete(socket));
    socket.on("error", () => {
      this.clients.delete(socket);
      socket.terminate();
    });
    socket.send(JSON.stringify(this.createEnvelope("snapshot")), (error) => {
      if (error) socket.terminate();
    });
  }

  private createEnvelope(type: StateEnvelope<T>["type"]): StateEnvelope<T> {
    this.sequence += 1;
    return { type, sequence: this.sequence, sentAt: Date.now(), state: this.getState() };
  }
}
