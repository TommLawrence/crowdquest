import type { TwitchRuntimeConfig } from "./config.js";
import type { StreamerIdentity } from "./session.js";

export class TwitchApiError extends Error {
  constructor(readonly status: number, readonly category: "authorization" | "request" | "network" | "response") {
    super(category === "network" ? "Twitch could not be reached." : "Twitch API request failed.");
    this.name = "TwitchApiError";
  }
}

export interface TwitchTokenResponse {
  accessToken: string;
  refreshToken: string | null;
  expiresIn: number;
  scopes: string[];
}

export interface TwitchTokenValidation {
  clientId: string;
  userId: string;
  login: string;
  scopes: string[];
  expiresIn: number;
}

export class TwitchApi {
  constructor(
    private readonly config: Pick<TwitchRuntimeConfig, "clientId" | "clientSecret" | "redirectUri">,
    private readonly fetcher: typeof fetch = fetch,
  ) {}

  async exchangeCode(code: string): Promise<TwitchTokenResponse> {
    const body = new URLSearchParams({
      client_id: this.config.clientId,
      client_secret: this.config.clientSecret,
      code,
      grant_type: "authorization_code",
      redirect_uri: this.config.redirectUri.toString(),
    });
    return parseTokenResponse(await this.request("https://id.twitch.tv/oauth2/token", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body,
    }));
  }

  async refreshToken(refreshToken: string): Promise<TwitchTokenResponse> {
    const body = new URLSearchParams({
      client_id: this.config.clientId,
      client_secret: this.config.clientSecret,
      grant_type: "refresh_token",
      refresh_token: refreshToken,
    });
    return parseTokenResponse(await this.request("https://id.twitch.tv/oauth2/token", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body,
    }));
  }

  async validateAccessToken(accessToken: string): Promise<TwitchTokenValidation> {
    const value = await this.request("https://id.twitch.tv/oauth2/validate", {
      headers: { authorization: `OAuth ${accessToken}` },
    });
    if (
      !isRecord(value) ||
      typeof value.client_id !== "string" ||
      typeof value.user_id !== "string" ||
      typeof value.login !== "string" ||
      !Number.isSafeInteger(value.expires_in)
    ) {
      throw new TwitchApiError(502, "response");
    }
    const scopes = parseScopes(value.scopes);
    return { clientId: value.client_id, userId: value.user_id, login: value.login, scopes, expiresIn: value.expires_in as number };
  }

  async getAuthorizedUser(accessToken: string): Promise<StreamerIdentity> {
    const value = await this.request("https://api.twitch.tv/helix/users", {
      headers: {
        authorization: `Bearer ${accessToken}`,
        "client-id": this.config.clientId,
      },
    });
    if (!isRecord(value) || !Array.isArray(value.data) || !isRecord(value.data[0])) {
      throw new TwitchApiError(502, "response");
    }
    const user = value.data[0];
    if (
      typeof user.id !== "string" ||
      typeof user.login !== "string" ||
      typeof user.display_name !== "string" ||
      !/^[a-z0-9_]{1,25}$/i.test(user.login) ||
      user.display_name.length < 1 ||
      user.display_name.length > 50 ||
      /[\u0000-\u001f\u007f]/u.test(user.display_name)
    ) {
      throw new TwitchApiError(502, "response");
    }
    return { id: user.id, login: user.login, displayName: user.display_name };
  }

  async createChatSubscription(accessToken: string, broadcasterId: string, sessionId: string): Promise<string> {
    const value = await this.request("https://api.twitch.tv/helix/eventsub/subscriptions", {
      method: "POST",
      headers: {
        authorization: `Bearer ${accessToken}`,
        "client-id": this.config.clientId,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        type: "channel.chat.message",
        version: "1",
        condition: { broadcaster_user_id: broadcasterId, user_id: broadcasterId },
        transport: { method: "websocket", session_id: sessionId },
      }),
      timeoutMs: 7_000,
    });
    if (!isRecord(value) || !Array.isArray(value.data) || !isRecord(value.data[0])) {
      throw new TwitchApiError(502, "response");
    }
    const subscription = value.data[0];
    if (
      subscription.type !== "channel.chat.message" ||
      subscription.version !== "1" ||
      subscription.status !== "enabled" ||
      typeof subscription.id !== "string"
    ) {
      throw new TwitchApiError(502, "response");
    }
    return subscription.id;
  }

  async revokeAccessToken(accessToken: string): Promise<void> {
    const body = new URLSearchParams({ client_id: this.config.clientId, token: accessToken });
    await this.request("https://id.twitch.tv/oauth2/revoke", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body,
    });
  }

  private async request(url: string, init: RequestInit & { timeoutMs?: number }): Promise<unknown> {
    const { timeoutMs = 10_000, ...requestInit } = init;
    let response: Response;
    try {
      response = await this.fetcher(url, { ...requestInit, signal: AbortSignal.timeout(timeoutMs) });
    } catch {
      throw new TwitchApiError(0, "network");
    }
    if (!response.ok && !(url.endsWith("/oauth2/revoke") && response.status === 200)) {
      throw new TwitchApiError(response.status, response.status === 401 ? "authorization" : "request");
    }
    if (response.status === 204 || url.endsWith("/oauth2/revoke")) return null;
    try {
      return await response.json() as unknown;
    } catch {
      throw new TwitchApiError(502, "response");
    }
  }
}

function parseTokenResponse(value: unknown): TwitchTokenResponse {
  if (
    !isRecord(value) ||
    typeof value.access_token !== "string" ||
    value.access_token.length < 1 ||
    value.access_token.length > 4096 ||
    (value.refresh_token !== undefined && typeof value.refresh_token !== "string") ||
    !Number.isSafeInteger(value.expires_in) ||
    (value.expires_in as number) <= 0
  ) {
    throw new TwitchApiError(502, "response");
  }
  return {
    accessToken: value.access_token,
    refreshToken: typeof value.refresh_token === "string" && value.refresh_token.length > 0 ? value.refresh_token : null,
    expiresIn: value.expires_in as number,
    scopes: parseScopes(value.scope),
  };
}

function parseScopes(value: unknown): string[] {
  if (Array.isArray(value) && value.every((scope) => typeof scope === "string")) return value;
  if (typeof value === "string") return value.split(/\s+/).filter(Boolean);
  return [];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
