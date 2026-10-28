import type { TwitchRuntimeConfig } from "./config.js";
import type { StreamerIdentity } from "./session.js";
import { EncryptedTokenStore, type StoredTwitchTokens } from "./token-store.js";
import { TwitchApi, TwitchApiError, type TwitchTokenResponse, type TwitchTokenValidation } from "./twitch-api.js";

const CHAT_READ_SCOPE = "user:read:chat";

export class TwitchAuthService {
  private currentTokens: StoredTwitchTokens | null = null;
  private refreshInFlight: Promise<StoredTwitchTokens | null> | null = null;

  constructor(
    private readonly config: Pick<TwitchRuntimeConfig, "clientId">,
    private readonly api: TwitchApi,
    private readonly tokenStore: EncryptedTokenStore,
  ) {}

  get identity(): StreamerIdentity | null {
    return this.currentTokens?.identity ?? null;
  }

  get isConnected(): boolean {
    return this.currentTokens !== null;
  }

  async completeAuthorization(code: string): Promise<StoredTwitchTokens> {
    const tokenResponse = await this.api.exchangeCode(code);
    const validated = await this.validate(tokenResponse.accessToken);
    const identity = await this.identityFor(tokenResponse.accessToken, validated);
    const stored = makeStoredTokens(tokenResponse, validated, identity, null);
    await this.tokenStore.save(stored);
    this.currentTokens = stored;
    return stored;
  }

  async restore(): Promise<StoredTwitchTokens | null> {
    const stored = await this.tokenStore.load();
    if (!stored) {
      this.currentTokens = null;
      return null;
    }
    try {
      const validation = await this.validate(stored.accessToken);
      this.assertChatScope(validation.scopes);
      const identity = await this.identityFor(stored.accessToken, validation, stored.identity);
      const refreshedRecord = { ...stored, expiresAt: Date.now() + validation.expiresIn * 1_000, scopes: validation.scopes, identity };
      await this.tokenStore.save(refreshedRecord);
      this.currentTokens = refreshedRecord;
      return refreshedRecord;
    } catch (error) {
      if (error instanceof TwitchApiError && error.status === 401) return this.refresh(stored);
      if (error instanceof TwitchApiError && error.status === 403) {
        await this.tokenStore.clear();
        this.currentTokens = null;
        return null;
      }
      throw error;
    }
  }

  async getAccessToken(): Promise<string> {
    if (!this.currentTokens) {
      const restored = await this.restore();
      if (!restored) throw new Error("Twitch is not connected.");
    }
    return this.currentTokens?.accessToken ?? failNoToken();
  }

  async refreshAfterUnauthorized(): Promise<string> {
    if (!this.currentTokens) throw new Error("Twitch is not connected.");
    const refreshed = await this.refresh(this.currentTokens);
    if (!refreshed) throw new TwitchApiError(401, "authorization");
    return refreshed.accessToken;
  }

  async revalidate(): Promise<StoredTwitchTokens | null> {
    if (!this.currentTokens) return this.restore();
    try {
      const validation = await this.validate(this.currentTokens.accessToken);
      this.assertChatScope(validation.scopes);
      const updated = {
        ...this.currentTokens,
        scopes: validation.scopes,
        expiresAt: Date.now() + validation.expiresIn * 1_000,
      };
      await this.tokenStore.save(updated);
      this.currentTokens = updated;
      return updated;
    } catch (error) {
      if (error instanceof TwitchApiError && error.status === 401) return this.refresh(this.currentTokens);
      if (error instanceof TwitchApiError && error.status === 403) {
        await this.tokenStore.clear();
        this.currentTokens = null;
        return null;
      }
      throw error;
    }
  }

  async disconnect(): Promise<{ revoked: boolean }> {
    const tokens = this.currentTokens ?? await this.tokenStore.load();
    let revoked = true;
    if (tokens) {
      try {
        await this.api.revokeAccessToken(tokens.accessToken);
      } catch {
        revoked = false;
      }
    }
    await this.tokenStore.clear();
    this.currentTokens = null;
    return { revoked };
  }

  async clearInvalidAuthorization(): Promise<void> {
    await this.tokenStore.clear();
    this.currentTokens = null;
  }

  private async validate(accessToken: string): Promise<TwitchTokenValidation> {
    const validation = await this.api.validateAccessToken(accessToken);
    if (validation.clientId !== this.config.clientId) throw new TwitchApiError(401, "authorization");
    this.assertChatScope(validation.scopes);
    return validation;
  }

  private async identityFor(
    accessToken: string,
    validation: TwitchTokenValidation,
    priorIdentity?: StreamerIdentity,
  ): Promise<StreamerIdentity> {
    if (priorIdentity && (priorIdentity.id !== validation.userId || priorIdentity.login !== validation.login)) {
      throw new TwitchApiError(401, "authorization");
    }
    const identity = await this.api.getAuthorizedUser(accessToken);
    if (identity.id !== validation.userId || identity.login.toLowerCase() !== validation.login.toLowerCase()) {
      throw new TwitchApiError(401, "authorization");
    }
    return identity;
  }

  private assertChatScope(scopes: string[]): void {
    if (!scopes.includes(CHAT_READ_SCOPE)) throw new TwitchApiError(403, "authorization");
  }

  private async refresh(tokens: StoredTwitchTokens): Promise<StoredTwitchTokens | null> {
    if (this.refreshInFlight) return this.refreshInFlight;
    this.refreshInFlight = this.performRefresh(tokens);
    try {
      return await this.refreshInFlight;
    } finally {
      this.refreshInFlight = null;
    }
  }

  private async performRefresh(tokens: StoredTwitchTokens): Promise<StoredTwitchTokens | null> {
    try {
      const response = await this.api.refreshToken(tokens.refreshToken);
      const rotated: StoredTwitchTokens = {
        ...tokens,
        accessToken: response.accessToken,
        refreshToken: response.refreshToken ?? tokens.refreshToken,
        expiresAt: Date.now() + response.expiresIn * 1_000,
      };
      await this.tokenStore.save(rotated);
      this.currentTokens = rotated;
      const validation = await this.validate(response.accessToken);
      const identity = await this.identityFor(response.accessToken, validation, tokens.identity);
      const updated = { ...rotated, scopes: validation.scopes, identity };
      await this.tokenStore.save(updated);
      this.currentTokens = updated;
      return updated;
    } catch (error) {
      if (error instanceof TwitchApiError && [400, 401, 403].includes(error.status)) {
        await this.tokenStore.clear();
        this.currentTokens = null;
        return null;
      }
      throw error;
    }
  }
}

function makeStoredTokens(
  response: TwitchTokenResponse,
  validation: TwitchTokenValidation,
  identity: StreamerIdentity,
  priorRefreshToken: string | null,
): StoredTwitchTokens {
  const refreshToken = response.refreshToken ?? priorRefreshToken;
  if (!refreshToken) throw new TwitchApiError(502, "response");
  return {
    accessToken: response.accessToken,
    refreshToken,
    expiresAt: Date.now() + response.expiresIn * 1_000,
    scopes: validation.scopes,
    identity,
  };
}

function failNoToken(): never {
  throw new Error("Twitch is not connected.");
}
