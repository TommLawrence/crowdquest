export interface IncomingChatMessage {
  notificationId: string;
  messageId: string;
  broadcasterId: string;
  userId: string;
  login: string;
  displayName: string;
  text: string;
  timestamp: number;
}

export function normalizeChatNotification(
  raw: unknown,
  expectedBroadcasterId: string,
  receivedAt = Date.now(),
): IncomingChatMessage | null {
  if (!isRecord(raw) || !isRecord(raw.metadata) || !isRecord(raw.payload)) return null;
  if (raw.metadata.message_type !== "notification" || raw.metadata.subscription_type !== "channel.chat.message") return null;
  if (typeof raw.metadata.message_id !== "string" || raw.metadata.message_id.length > 128) return null;
  if (!isRecord(raw.payload.subscription) || !isRecord(raw.payload.event)) return null;

  const subscription = raw.payload.subscription;
  const event = raw.payload.event;
  if (
    subscription.type !== "channel.chat.message" ||
    subscription.version !== "1" ||
    !isRecord(subscription.condition) ||
    subscription.condition.broadcaster_user_id !== expectedBroadcasterId ||
    event.broadcaster_user_id !== expectedBroadcasterId ||
    typeof event.message_id !== "string" ||
    event.message_id.length < 1 ||
    event.message_id.length > 128 ||
    typeof event.chatter_user_id !== "string" ||
    event.chatter_user_id.length < 1 ||
    event.chatter_user_id.length > 64 ||
    typeof event.chatter_user_login !== "string" ||
    !/^[a-z0-9_]{1,25}$/i.test(event.chatter_user_login) ||
    typeof event.chatter_user_name !== "string" ||
    event.chatter_user_name.length < 1 ||
    event.chatter_user_name.length > 50 ||
    /[\u0000-\u001f\u007f]/u.test(event.chatter_user_name) ||
    !isRecord(event.message) ||
    typeof event.message.text !== "string" ||
    event.message.text.length > 500
  ) {
    return null;
  }

  const eventTime = typeof raw.metadata.message_timestamp === "string"
    ? Date.parse(raw.metadata.message_timestamp)
    : Number.NaN;
  return {
    notificationId: raw.metadata.message_id,
    messageId: event.message_id,
    broadcasterId: expectedBroadcasterId,
    userId: event.chatter_user_id,
    login: event.chatter_user_login,
    displayName: event.chatter_user_name,
    text: event.message.text,
    timestamp: Number.isSafeInteger(eventTime) ? eventTime : receivedAt,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
