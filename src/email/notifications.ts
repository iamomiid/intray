import { badRequest } from "../lib/errors";

export type ProviderBounceKind = "hard" | "soft";

export interface ProviderBounceRecipient {
  address: string;
  kind: ProviderBounceKind;
  detail: string | null;
}

export interface ProviderBounce {
  provider: string;
  from: string;
  recipients: ProviderBounceRecipient[];
}

export type BounceNotification =
  | { kind: "bounce"; bounce: ProviderBounce }
  | { kind: "confirmation"; provider: string; subscribeUrl: string };

type JsonObject = Record<string, unknown>;

function asRecord(value: unknown): JsonObject | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as JsonObject)
    : null;
}

function asText(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function asList(value: unknown): unknown[] {
  if (Array.isArray(value)) {
    return value;
  }
  return value === undefined || value === null ? [] : [value];
}

function detailOf(value: unknown): string | null {
  const text = asText(value);
  return text === "" ? null : text;
}

function parseSnsMessage(raw: unknown): JsonObject | null {
  const nested = asRecord(raw);
  if (nested !== null) {
    return nested;
  }
  const text = asText(raw);
  if (text === "") {
    return null;
  }
  try {
    return asRecord(JSON.parse(text));
  } catch {
    return null;
  }
}

function snsRecipients(bounce: JsonObject, permanent: boolean): ProviderBounceRecipient[] {
  return asList(bounce.bouncedRecipients).flatMap((entry) => {
    const recipient = asRecord(entry);
    const address = asText(recipient?.emailAddress);
    if (recipient === null || address === "") {
      return [];
    }
    return [
      {
        address,
        kind: permanent ? ("hard" as const) : ("soft" as const),
        detail: detailOf(recipient.diagnosticCode),
      },
    ];
  });
}

function parseSns(payload: JsonObject): BounceNotification | null {
  const type = asText(payload.Type);
  if (type === "SubscriptionConfirmation") {
    const subscribeUrl = asText(payload.SubscribeURL);
    if (subscribeUrl === "") {
      throw badRequest("the subscription confirmation carries no SubscribeURL");
    }
    return { kind: "confirmation", provider: "ses", subscribeUrl };
  }
  if (type !== "Notification") {
    return null;
  }
  const notification = parseSnsMessage(payload.Message);
  if (notification === null || asText(notification.notificationType) !== "Bounce") {
    throw badRequest("the notification is not an SES bounce");
  }
  const bounce = asRecord(notification.bounce);
  const mail = asRecord(notification.mail);
  const from = asText(mail?.source);
  if (bounce === null || from === "") {
    throw badRequest("the notification names no bounce or no sending address");
  }
  const recipients = snsRecipients(bounce, asText(bounce.bounceType) === "Permanent");
  if (recipients.length === 0) {
    throw badRequest("the notification names no bounced recipient");
  }
  return { kind: "bounce", bounce: { provider: "ses", from, recipients } };
}

function parseResend(payload: JsonObject): BounceNotification | null {
  if (asText(payload.type) !== "email.bounced") {
    return null;
  }
  const data = asRecord(payload.data);
  const from = asText(data?.from);
  const bounce = asRecord(data?.bounce);
  if (data === null || from === "") {
    throw badRequest("the webhook names no sending address");
  }
  const kind = asText(bounce?.type).toLowerCase() === "soft" ? "soft" : "hard";
  const detail = detailOf(bounce?.message);
  const recipients = asList(data.to).flatMap((entry) => {
    const address = asText(entry);
    return address === "" ? [] : [{ address, kind: kind as ProviderBounceKind, detail }];
  });
  if (recipients.length === 0) {
    throw badRequest("the webhook names no bounced recipient");
  }
  return { kind: "bounce", bounce: { provider: "resend", from, recipients } };
}

function parseGeneric(payload: JsonObject): BounceNotification {
  const provider = asText(payload.provider);
  const address = asText(payload.address);
  const from = asText(payload.from);
  const kind = asText(payload.kind).toLowerCase();
  if (provider === "" || address === "" || from === "") {
    throw badRequest("provider, address and from are required");
  }
  if (kind !== "hard" && kind !== "soft") {
    throw badRequest("kind must be hard or soft");
  }
  return {
    kind: "bounce",
    bounce: {
      provider,
      from,
      recipients: [{ address, kind, detail: detailOf(payload.detail) }],
    },
  };
}

export function parseBounceNotification(payload: unknown): BounceNotification {
  const record = asRecord(payload);
  if (record === null) {
    throw badRequest("the notification must be a json object");
  }
  return parseSns(record) ?? parseResend(record) ?? parseGeneric(record);
}
