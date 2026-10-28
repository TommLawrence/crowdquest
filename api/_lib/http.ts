import type { IncomingMessage, ServerResponse } from "node:http";

export interface ApiRequest extends IncomingMessage { body?: unknown }

export function json(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", "x-content-type-options": "nosniff", "referrer-policy": "no-referrer" });
  response.end(JSON.stringify(body));
}

export function redirect(response: ServerResponse, location: string): void {
  response.writeHead(303, { location, "cache-control": "no-store", "referrer-policy": "no-referrer" });
  response.end();
}

export function requestUrl(request: IncomingMessage): URL {
  return new URL(request.url ?? "/", `https://${request.headers.host ?? "localhost"}`);
}

export function requestObject(request: ApiRequest): Record<string, unknown> | null {
  if (isRecord(request.body)) return request.body;
  if (typeof request.body === "string") {
    try { const parsed: unknown = JSON.parse(request.body); return isRecord(parsed) ? parsed : null; }
    catch { return null; }
  }
  if (Buffer.isBuffer(request.body)) {
    try { const parsed: unknown = JSON.parse(request.body.toString("utf8")); return isRecord(parsed) ? parsed : null; }
    catch { return null; }
  }
  return null;
}

export function methodNotAllowed(response: ServerResponse, allow: string): void {
  response.writeHead(405, { allow, "cache-control": "no-store" });
  response.end();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
