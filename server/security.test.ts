import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadConfig } from "./config.js";
import { SessionManager } from "./session.js";
import { EncryptedTokenStore, type StoredTwitchTokens } from "./token-store.js";
import { TwitchApiError } from "./twitch-api.js";
import { TwitchAuthService } from "./twitch-auth.js";

const directories: string[] = [];
const key = Buffer.alloc(32, 7);

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

function newStore(directory: string, encryptionKey = key): EncryptedTokenStore {
  return new EncryptedTokenStore(join(directory, "twitch-token.enc"), encryptionKey);
}

async function newDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "crowdquest-test-"));
  directories.push(directory);
  return directory;
}

const sampleTokens: StoredTwitchTokens = {
  accessToken: "access-token-secret-value",
  refreshToken: "refresh-token-secret-value",
  expiresAt: 1_900_000_000_000,
  scopes: ["user:read:chat"],
  identity: { id: "12345", login: "streamer", displayName: "Streamer" },
};

describe("configuration and signed session state", () => {
  it("reports missing Twitch settings without requiring secrets at boot", () => {
    const config = loadConfig({ PORT: "3000" });
    expect(config.twitch).toBeNull();
    expect(config.configurationError).toContain("TWITCH_CLIENT_ID");
    expect(config.configurationError).toContain("TOKEN_ENCRYPTION_KEY");
  });

  it("rejects non-HTTPS remote redirects and malformed encryption keys", () => {
    const env = validEnv();
    const remoteHttp = loadConfig({ ...env, TWITCH_REDIRECT_URI: "http://example.com/auth/twitch/callback" });
    expect(remoteHttp.configurationError).toContain("HTTPS redirect URL");
    expect(remoteHttp.configurationError).not.toContain(env.TWITCH_CLIENT_SECRET);

    const invalidKey = loadConfig({ ...env, TOKEN_ENCRYPTION_KEY: "not-a-key" });
    expect(invalidKey.configurationError).toContain("base64-encoded 32-byte key");
  });

  it("generates browser-bound OAuth state and rejects expiry, mismatch, and replay", () => {
    const manager = new SessionManager(Buffer.alloc(32, 5));
    const generated = manager.createOAuthState(1_000);
    expect(generated.state).toHaveLength(43);
    expect(manager.consumeOAuthState(generated.state, "wrong-cookie", 1_001)).toBe(false);
    expect(manager.consumeOAuthState(generated.state, generated.cookieValue, 1_002)).toBe(true);
    expect(manager.consumeOAuthState(generated.state, generated.cookieValue, 1_003)).toBe(false);

    const expired = manager.createOAuthState(2_000);
    expect(manager.consumeOAuthState(expired.state, expired.cookieValue, 602_000)).toBe(false);
  });

  it("signs server sessions and rejects tampered cookies", () => {
    const manager = new SessionManager(Buffer.alloc(32, 8));
    const session = manager.createSession(sampleTokens.identity, 10_000);
    expect(manager.resolveSession(session.cookieValue, 10_001)?.id).toBe("12345");
    expect(manager.resolveSession(`${session.cookieValue}x`, 10_001)).toBeNull();
    expect(manager.resolveSession(session.cookieValue, 10_000 + 12 * 60 * 60 * 1_000)).toBeNull();
  });
});

describe("encrypted Twitch token storage", () => {
  it("round-trips tokens while keeping their values out of the file", async () => {
    const directory = await newDirectory();
    const store = newStore(directory);
    await store.save(sampleTokens);
    const file = await readFile(join(directory, "twitch-token.enc"), "utf8");
    expect(file).not.toContain(sampleTokens.accessToken);
    expect(file).not.toContain(sampleTokens.refreshToken);
    expect(await store.load()).toEqual(sampleTokens);
  });

  it("fails closed when the wrong encryption key is supplied", async () => {
    const directory = await newDirectory();
    await newStore(directory).save(sampleTokens);
    await expect(newStore(directory, Buffer.alloc(32, 9)).load()).rejects.toThrow("Check TOKEN_ENCRYPTION_KEY");
  });
});

describe("Twitch token lifecycle", () => {
  it("validates app identity and preserves a rotated refresh token", async () => {
    const directory = await newDirectory();
    const store = newStore(directory);
    await store.save(sampleTokens);
    const api = {
      validateAccessToken: vi.fn()
        .mockRejectedValueOnce(new TwitchApiError(401, "authorization"))
        .mockResolvedValueOnce({ clientId: "client-id", userId: "12345", login: "streamer", scopes: ["user:read:chat"], expiresIn: 3_600 }),
      refreshToken: vi.fn().mockResolvedValue({
        accessToken: "rotated-access-token",
        refreshToken: "rotated-refresh-token",
        expiresIn: 3_600,
        scopes: ["user:read:chat"],
      }),
      getAuthorizedUser: vi.fn().mockResolvedValue(sampleTokens.identity),
    };
    const auth = new TwitchAuthService({ clientId: "client-id" }, api as never, store);

    const restored = await auth.restore();
    expect(restored?.accessToken).toBe("rotated-access-token");
    expect(restored?.refreshToken).toBe("rotated-refresh-token");
    expect(api.refreshToken).toHaveBeenCalledWith(sampleTokens.refreshToken);
    expect((await store.load())?.refreshToken).toBe("rotated-refresh-token");
  });

  it("clears tokens after Twitch rejects an expired refresh token", async () => {
    const directory = await newDirectory();
    const store = newStore(directory);
    await store.save(sampleTokens);
    const api = {
      validateAccessToken: vi.fn().mockRejectedValue(new TwitchApiError(401, "authorization")),
      refreshToken: vi.fn().mockRejectedValue(new TwitchApiError(400, "request")),
    };
    const auth = new TwitchAuthService({ clientId: "client-id" }, api as never, store);

    await expect(auth.restore()).resolves.toBeNull();
    await expect(store.load()).resolves.toBeNull();
    expect(auth.isConnected).toBe(false);
  });

  it("persists a rotated refresh token before validating the refreshed access token", async () => {
    const directory = await newDirectory();
    const store = newStore(directory);
    await store.save(sampleTokens);
    const api = {
      validateAccessToken: vi.fn()
        .mockRejectedValueOnce(new TwitchApiError(401, "authorization"))
        .mockRejectedValueOnce(new TwitchApiError(0, "network")),
      refreshToken: vi.fn().mockResolvedValue({
        accessToken: "rotated-access-token",
        refreshToken: "rotated-refresh-token",
        expiresIn: 3_600,
        scopes: ["user:read:chat"],
      }),
    };
    const auth = new TwitchAuthService({ clientId: "client-id" }, api as never, store);

    await expect(auth.restore()).rejects.toThrow("Twitch could not be reached");
    expect((await store.load())?.refreshToken).toBe("rotated-refresh-token");
    expect((await store.load())?.accessToken).toBe("rotated-access-token");
  });
});

function validEnv(): NodeJS.ProcessEnv {
  return {
    PORT: "3000",
    TWITCH_CLIENT_ID: "client-id",
    TWITCH_CLIENT_SECRET: "client-secret-value",
    TWITCH_REDIRECT_URI: "http://localhost:3000/auth/twitch/callback",
    SESSION_SECRET: "s".repeat(40),
    TOKEN_ENCRYPTION_KEY: Buffer.alloc(32, 1).toString("base64"),
  };
}
