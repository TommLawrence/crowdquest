import { resolve } from "node:path";

export interface TwitchRuntimeConfig {
  clientId: string;
  clientSecret: string;
  redirectUri: URL;
  callbackPath: string;
  sessionSecret: Buffer;
  tokenEncryptionKey: Buffer;
  dataFile: string;
  secureCookies: boolean;
}

export interface RuntimeConfig {
  port: number;
  host: string;
  simulatedChatEnabled: boolean;
  twitch: TwitchRuntimeConfig | null;
  configurationError: string | null;
}

export function loadConfig(env: NodeJS.ProcessEnv): RuntimeConfig {
  const port = Number(env.PORT ?? "3000");
  const host = env.HOST?.trim() || "127.0.0.1";
  const simulatedChatEnabled = env.SIMULATED_CHAT_ENABLED === "true";
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error("PORT must be an integer between 1 and 65535.");
  }

  const missing = [
    ["TWITCH_CLIENT_ID", env.TWITCH_CLIENT_ID],
    ["TWITCH_CLIENT_SECRET", env.TWITCH_CLIENT_SECRET],
    ["TWITCH_REDIRECT_URI", env.TWITCH_REDIRECT_URI],
    ["SESSION_SECRET", env.SESSION_SECRET],
    ["TOKEN_ENCRYPTION_KEY", env.TOKEN_ENCRYPTION_KEY],
  ].filter(([, value]) => !value?.trim()).map(([name]) => name);

  if (missing.length > 0) {
    return {
      port,
      host,
      simulatedChatEnabled,
      twitch: null,
      configurationError: `Twitch connection is not configured. Set: ${missing.join(", ")}.`,
    };
  }

  const sessionSecret = Buffer.from(env.SESSION_SECRET ?? "", "utf8");
  if (sessionSecret.length < 32) {
    return {
      port,
      host,
      simulatedChatEnabled,
      twitch: null,
      configurationError: "Twitch connection is not configured. SESSION_SECRET must contain at least 32 bytes.",
    };
  }

  const encryptionKeyText = env.TOKEN_ENCRYPTION_KEY ?? "";
  const tokenEncryptionKey = Buffer.from(encryptionKeyText, "base64");
  if (tokenEncryptionKey.length !== 32 || tokenEncryptionKey.toString("base64") !== encryptionKeyText) {
    return {
      port,
      host,
      simulatedChatEnabled,
      twitch: null,
      configurationError: "Twitch connection is not configured. TOKEN_ENCRYPTION_KEY must be a base64-encoded 32-byte key.",
    };
  }

  let redirectUri: URL;
  try {
    redirectUri = new URL(env.TWITCH_REDIRECT_URI ?? "");
  } catch {
    return {
      port,
      host,
      simulatedChatEnabled,
      twitch: null,
      configurationError: "Twitch connection is not configured. TWITCH_REDIRECT_URI must be a valid URL.",
    };
  }

  const isLocalHost = ["localhost", "127.0.0.1", "[::1]"].includes(redirectUri.hostname);
  if (
    (redirectUri.protocol !== "https:" && !(redirectUri.protocol === "http:" && isLocalHost)) ||
    redirectUri.username ||
    redirectUri.password ||
    redirectUri.search ||
    redirectUri.hash ||
    !/^\/[A-Za-z0-9/_-]*$/.test(redirectUri.pathname) ||
    !redirectUri.pathname.startsWith("/")
  ) {
    return {
      port,
      host,
      simulatedChatEnabled,
      twitch: null,
      configurationError: "Twitch connection is not configured. Use an HTTPS redirect URL, or HTTP localhost for development, without query or fragment values.",
    };
  }

  return {
    port,
    host,
    simulatedChatEnabled,
    twitch: {
      clientId: env.TWITCH_CLIENT_ID ?? "",
      clientSecret: env.TWITCH_CLIENT_SECRET ?? "",
      redirectUri,
      callbackPath: redirectUri.pathname,
      sessionSecret,
      tokenEncryptionKey,
      dataFile: resolve(env.DATA_DIR?.trim() || ".data", "twitch-token.enc"),
      secureCookies: redirectUri.protocol === "https:",
    },
    configurationError: null,
  };
}
