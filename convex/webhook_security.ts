const encoder = new TextEncoder();
export const MAX_WEBHOOK_AGE_MS = 10 * 60 * 1_000;
export const MAX_WEBHOOK_FUTURE_SKEW_MS = 30_000;

export async function verifyTwitchWebhook(input: {
  secret: string;
  messageId: string | null;
  timestamp: string | null;
  signature: string | null;
  rawBody: string;
  nowMs?: number;
}): Promise<boolean> {
  if (input.secret.length < 10 || input.secret.length > 100 || !input.messageId || !input.timestamp || !input.signature) return false;
  const timestampMs = Date.parse(input.timestamp);
  if (!Number.isFinite(timestampMs)) return false;
  const age = (input.nowMs ?? Date.now()) - timestampMs;
  if (age > MAX_WEBHOOK_AGE_MS || age < -MAX_WEBHOOK_FUTURE_SKEW_MS) return false;
  const match = /^sha256=([a-f0-9]{64})$/i.exec(input.signature);
  if (!match?.[1]) return false;
  try {
    const key = await crypto.subtle.importKey("raw", encoder.encode(input.secret), { name: "HMAC", hash: "SHA-256" }, false, ["verify"]);
    const signature = hexToBytes(match[1]);
    const signatureBuffer = new ArrayBuffer(signature.byteLength);
    new Uint8Array(signatureBuffer).set(signature);
    const message = encoder.encode(input.messageId + input.timestamp + input.rawBody);
    return await crypto.subtle.verify("HMAC", key, signatureBuffer, message);
  } catch {
    return false;
  }
}

export function constantTimeTextEqual(left: string, right: string): boolean {
  const a = encoder.encode(left);
  const b = encoder.encode(right);
  let mismatch = a.length ^ b.length;
  const length = Math.max(a.length, b.length);
  for (let index = 0; index < length; index += 1) mismatch |= (a[index] ?? 0) ^ (b[index] ?? 0);
  return mismatch === 0;
}

function hexToBytes(value: string): Uint8Array {
  const output = new Uint8Array(value.length / 2);
  for (let index = 0; index < output.length; index += 1) output[index] = Number.parseInt(value.slice(index * 2, index * 2 + 2), 16);
  return output;
}
