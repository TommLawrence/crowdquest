import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { StreamerIdentity } from "./session.js";

export interface StoredTwitchTokens {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
  scopes: string[];
  identity: StreamerIdentity;
}

interface EncryptedRecord {
  version: 1;
  iv: string;
  tag: string;
  ciphertext: string;
}

export class EncryptedTokenStore {
  constructor(private readonly filePath: string, private readonly key: Buffer) {}

  async load(): Promise<StoredTwitchTokens | null> {
    let contents: string;
    try {
      contents = await readFile(this.filePath, "utf8");
    } catch (error) {
      if (isNotFound(error)) return null;
      throw new Error("Unable to read the encrypted Twitch token store.");
    }

    try {
      const record = parseEncryptedRecord(JSON.parse(contents) as unknown);
      const decipher = createDecipheriv("aes-256-gcm", this.key, Buffer.from(record.iv, "base64"));
      decipher.setAuthTag(Buffer.from(record.tag, "base64"));
      const plaintext = Buffer.concat([
        decipher.update(Buffer.from(record.ciphertext, "base64")),
        decipher.final(),
      ]).toString("utf8");
      return parseStoredTokens(JSON.parse(plaintext) as unknown);
    } catch {
      throw new Error("The encrypted Twitch token store is unreadable. Check TOKEN_ENCRYPTION_KEY or reconnect Twitch.");
    }
  }

  async save(tokens: StoredTwitchTokens): Promise<void> {
    if (this.key.length !== 32) throw new Error("TOKEN_ENCRYPTION_KEY must be 32 bytes.");
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.key, iv);
    const ciphertext = Buffer.concat([cipher.update(JSON.stringify(tokens), "utf8"), cipher.final()]);
    const record: EncryptedRecord = {
      version: 1,
      iv: iv.toString("base64"),
      tag: cipher.getAuthTag().toString("base64"),
      ciphertext: ciphertext.toString("base64"),
    };
    const destinationDirectory = dirname(this.filePath);
    const temporaryPath = `${this.filePath}.${randomBytes(8).toString("hex")}.tmp`;
    await mkdir(destinationDirectory, { recursive: true, mode: 0o700 });
    await chmod(destinationDirectory, 0o700);
    try {
      await writeFile(temporaryPath, JSON.stringify(record), { encoding: "utf8", mode: 0o600, flag: "wx" });
      await rename(temporaryPath, this.filePath);
    } catch (error) {
      try {
        await rm(temporaryPath, { force: true });
      } catch (cleanupError) {
        throw new AggregateError([error, cleanupError], "Could not safely save the encrypted Twitch token store.");
      }
      throw new Error("Could not safely save the encrypted Twitch token store.");
    }
  }

  async clear(): Promise<void> {
    try {
      await rm(this.filePath, { force: true });
    } catch {
      throw new Error("Could not clear the encrypted Twitch token store.");
    }
  }
}

function parseEncryptedRecord(value: unknown): EncryptedRecord {
  if (!isRecord(value) || value.version !== 1) throw new Error("Invalid encrypted token record.");
  if (typeof value.iv !== "string" || typeof value.tag !== "string" || typeof value.ciphertext !== "string") {
    throw new Error("Invalid encrypted token record.");
  }
  return { version: 1, iv: value.iv, tag: value.tag, ciphertext: value.ciphertext };
}

function parseStoredTokens(value: unknown): StoredTwitchTokens {
  if (!isRecord(value) || typeof value.accessToken !== "string" || typeof value.refreshToken !== "string") {
    throw new Error("Invalid token data.");
  }
  if (!Number.isSafeInteger(value.expiresAt) || !Array.isArray(value.scopes) || !value.scopes.every((scope) => typeof scope === "string")) {
    throw new Error("Invalid token data.");
  }
  if (!isRecord(value.identity) || typeof value.identity.id !== "string" || typeof value.identity.login !== "string" || typeof value.identity.displayName !== "string") {
    throw new Error("Invalid token identity.");
  }
  return {
    accessToken: value.accessToken,
    refreshToken: value.refreshToken,
    expiresAt: value.expiresAt as number,
    scopes: value.scopes as string[],
    identity: {
      id: value.identity.id,
      login: value.identity.login,
      displayName: value.identity.displayName,
    },
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNotFound(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}
