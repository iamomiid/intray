import { getInbox } from "../db/inboxes";
import {
  type InboundInput,
  InboundRejected,
  type InboundResult,
  ingestInbound,
} from "../email/inbound";
import { type BounceNotification, parseBounceNotification } from "../email/notifications";
import type { Env } from "../env";
import { isValidEmail, normalizeAddress, splitTag } from "../lib/address";
import { AppError, badRequest, forbidden, notFound } from "../lib/errors";
import { base64Decode, constantTimeEqual, sha256Hex } from "../lib/hash";
import { warnOnce } from "../lib/warn";
import { recordProviderBounce } from "./suppressions";

export const INBOUND_SECRET_MIN_LENGTH = 32;

export interface InboundJsonBody {
  envelope_from?: unknown;
  envelope_to?: unknown;
  raw?: unknown;
}

export interface BounceFeedResult {
  provider: string;
  inbox_id: string | null;
  recorded: number;
  confirmed: boolean;
}

function inboundSecret(env: Env): string | null {
  const secret = env.INBOUND_SECRET;
  if (typeof secret !== "string" || secret.length === 0) {
    return null;
  }
  if (secret.length < INBOUND_SECRET_MIN_LENGTH) {
    warnOnce(
      `INBOUND_SECRET is shorter than ${INBOUND_SECRET_MIN_LENGTH} characters and is ignored`,
    );
    return null;
  }
  return secret;
}

export async function requireInboundSecret(env: Env, presented: string | null): Promise<void> {
  const secret = inboundSecret(env);
  if (secret === null || presented === null || presented.length === 0) {
    throw forbidden("inbound secret required");
  }
  if (!constantTimeEqual(await sha256Hex(presented.trim()), await sha256Hex(secret))) {
    throw forbidden("inbound secret required");
  }
}

function envelopeAddress(value: unknown, field: string): string {
  const address = typeof value === "string" ? value.trim() : "";
  if (address === "" || !isValidEmail(address)) {
    throw badRequest(`${field} must be an email address`, "invalid_address");
  }
  return address;
}

export function inboundFromRaw(
  envelopeFrom: string | null,
  envelopeTo: string | null,
  raw: Uint8Array,
): InboundInput {
  if (raw.byteLength === 0) {
    throw badRequest("the request body is empty");
  }
  return {
    envelopeFrom: envelopeAddress(envelopeFrom, "x-envelope-from"),
    envelopeTo: envelopeAddress(envelopeTo, "x-envelope-to"),
    raw,
  };
}

export function inboundFromJson(body: InboundJsonBody): InboundInput {
  const encoded = typeof body.raw === "string" ? body.raw.trim() : "";
  if (encoded === "") {
    throw badRequest("raw must be the base64 of the rfc822 message");
  }
  const raw = ((): Uint8Array => {
    try {
      return base64Decode(encoded);
    } catch {
      throw badRequest("raw must be the base64 of the rfc822 message");
    }
  })();
  return {
    envelopeFrom: envelopeAddress(body.envelope_from, "envelope_from"),
    envelopeTo: envelopeAddress(body.envelope_to, "envelope_to"),
    raw,
  };
}

export async function receiveInbound(env: Env, input: InboundInput): Promise<InboundResult> {
  try {
    return await ingestInbound(env, input);
  } catch (error) {
    if (error instanceof InboundRejected) {
      throw new AppError(400, "rejected", error.reason);
    }
    throw error;
  }
}

async function confirmSubscription(subscribeUrl: string): Promise<void> {
  try {
    await fetch(subscribeUrl, { method: "GET" });
  } catch (error) {
    console.error("could not confirm the notification subscription", error);
  }
}

async function recordNotifiedBounce(
  env: Env,
  notification: Extract<BounceNotification, { kind: "bounce" }>,
): Promise<BounceFeedResult> {
  const { address } = splitTag(normalizeAddress(notification.bounce.from));
  const inbox = await getInbox(env.DB, address);
  if (inbox === null) {
    throw notFound(`no inbox sends as ${address}`);
  }
  return {
    provider: notification.bounce.provider,
    inbox_id: inbox.inbox_id,
    recorded: await recordProviderBounce(env, inbox.account_id, notification.bounce.recipients),
    confirmed: false,
  };
}

export async function receiveBounceNotification(
  env: Env,
  payload: unknown,
): Promise<BounceFeedResult> {
  const notification = parseBounceNotification(payload);
  if (notification.kind === "confirmation") {
    await confirmSubscription(notification.subscribeUrl);
    return { provider: notification.provider, inbox_id: null, recorded: 0, confirmed: true };
  }
  return recordNotifiedBounce(env, notification);
}
