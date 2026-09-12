import { env } from "cloudflare:test";
import { beforeEach, expect, it } from "vitest";
import { me, signup, verify } from "../src/core/accounts";
import { authenticate } from "../src/core/keys";
import type { Principal } from "../src/core/principal";
import { countInboxes } from "../src/db/inboxes";
import { deleteOtps, getLatestOtp, insertOtp } from "../src/db/otps";
import type { Env } from "../src/env";
import { AppError } from "../src/lib/errors";
import { sha256Hex } from "../src/lib/hash";
import { OTP_MAX_ATTEMPTS, OTP_MAX_PER_HOUR } from "../src/lib/otp";
import { now } from "../src/lib/time";
import { indexes, resetDatabase } from "./support";

const EMAIL = "human@agents.test";

interface SentEmail {
  to: string;
  subject: string;
  text: string;
  html: string;
}

interface FakeEmail {
  binding: SendEmail;
  sent: SentEmail[];
}

function recipient(to: EmailMessageBuilder["to"]): string {
  if (typeof to === "string") {
    return to;
  }
  const [first] = Array.isArray(to) ? to : [];
  return typeof first === "string" ? first : "";
}

function fakeEmail(options: { failing?: boolean } = {}): FakeEmail {
  const sent: SentEmail[] = [];
  const binding: SendEmail = {
    async send(message: EmailMessage | EmailMessageBuilder): Promise<EmailSendResult> {
      if (options.failing === true) {
        throw new Error("send_email is unavailable");
      }
      if ("subject" in message) {
        sent.push({
          to: recipient(message.to),
          subject: message.subject,
          text: message.text ?? "",
          html: message.html ?? "",
        });
      }
      return { messageId: "<test@local>" };
    },
  };
  return { binding, sent };
}

function fakeRate(success: boolean): RateLimit {
  return {
    async limit(_options: RateLimitOptions): Promise<RateLimitOutcome> {
      return { success };
    },
  };
}

function testEnv(overrides: Partial<Env> = {}): Env {
  return { ...env, ...overrides };
}

function codeFrom(email: FakeEmail, index = 0): string {
  const subject = email.sent[index]?.subject ?? "";
  const match = /^(\d{6}) is your intray verification code$/.exec(subject);
  expect(match).not.toBeNull();
  return match?.[1] ?? "";
}

async function principalOf(apiKey: string): Promise<Principal> {
  const principal = await authenticate(env, apiKey);
  expect(principal).not.toBeNull();
  return principal as Principal;
}

async function pendingPrincipalOf(apiKey: string): Promise<Principal> {
  const principal = await authenticate(env, apiKey, { allowPending: true });
  expect(principal).not.toBeNull();
  return principal as Principal;
}

async function rejectsWith(
  promise: Promise<unknown>,
  status: number,
  code: string,
): Promise<AppError> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(AppError);
    const failure = error as AppError;
    expect([failure.status, failure.code]).toEqual([status, code]);
    return failure;
  }
  throw new Error("expected the call to reject");
}

beforeEach(async () => {
  await resetDatabase(env.DB);
});

it("creates an account, an inbox, a key, and mails the code", async () => {
  const email = fakeEmail();

  const result = await signup(testEnv({ EMAIL: email.binding }), { email: EMAIL });

  expect(result.account_id.startsWith("acc_")).toBe(true);
  expect(result.inbox_id.endsWith("@intray.example")).toBe(true);
  expect(result.verified).toBe(false);
  expect(result.otp_sent).toBe(true);

  const principal = await principalOf(result.api_key);
  expect(principal.account.id).toBe(result.account_id);
  expect(principal.account.email).toBe(EMAIL);

  const otp = await getLatestOtp(env.DB, result.account_id);
  expect(otp).not.toBeNull();
  expect(otp?.attempts).toBe(0);
  expect(otp?.expires_at).toBeGreaterThan(now());

  expect(email.sent).toHaveLength(1);
  expect(email.sent[0]?.to).toBe(EMAIL);
  const code = codeFrom(email);
  expect(otp?.code_hash).toBe(await sha256Hex(code));
  expect(email.sent[0]?.text).toContain(code);
  expect(email.sent[0]?.text).toContain("10 minutes");
  expect(email.sent[0]?.html).toContain(code);

  const seen = await me(env, principal);
  expect(seen.account.email).toBe(EMAIL);
  expect(seen.account.verified).toBe(false);
  expect(seen.inbox_count).toBe(1);
  expect(seen.key_id).toBe(principal.keyId);
});

it("honors a requested username and normalizes the email", async () => {
  const email = fakeEmail();

  const result = await signup(testEnv({ EMAIL: email.binding }), {
    email: "  Human@Agents.Test ",
    username: "Desk-Agent",
  });

  expect(result.inbox_id).toBe("desk-agent@intray.example");
  const principal = await principalOf(result.api_key);
  expect(principal.account.email).toBe(EMAIL);
});

it("reports otp_sent false when the mail send fails", async () => {
  const email = fakeEmail({ failing: true });

  const result = await signup(testEnv({ EMAIL: email.binding }), { email: EMAIL });

  expect(result.otp_sent).toBe(false);
  expect(await getLatestOtp(env.DB, result.account_id)).not.toBeNull();
});

it("mints a pending key and keeps the old one working on a repeat signup", async () => {
  const email = fakeEmail();
  const first = await signup(testEnv({ EMAIL: email.binding }), { email: EMAIL });
  expect(first.key_pending).toBe(false);

  const second = await signup(testEnv({ EMAIL: email.binding }), {
    email: EMAIL,
    username: "another-name",
  });

  expect(second.account_id).toBe(first.account_id);
  expect(second.inbox_id).toBe(first.inbox_id);
  expect(second.api_key).not.toBe(first.api_key);
  expect(second.key_pending).toBe(true);
  expect(second.otp_sent).toBe(true);
  expect(await authenticate(env, first.api_key)).not.toBeNull();
  expect(await authenticate(env, second.api_key)).toBeNull();
  expect((await pendingPrincipalOf(second.api_key)).pending).toBe(true);
  expect(await countInboxes(env.DB, first.account_id)).toBe(1);
});

it("activates the pending key and revokes the rest on verify", async () => {
  const email = fakeEmail();
  const target = testEnv({ EMAIL: email.binding });
  const first = await signup(target, { email: EMAIL });
  await verify(env, await principalOf(first.api_key), { code: codeFrom(email) });

  const second = await signup(target, { email: EMAIL });
  expect(second.verified).toBe(true);
  expect(second.key_pending).toBe(true);
  expect(second.otp_sent).toBe(true);

  const pending = await pendingPrincipalOf(second.api_key);
  const verified = await verify(env, pending, { code: codeFrom(email, 1) });

  expect(verified.account_id).toBe(first.account_id);
  expect(verified.verified).toBe(true);
  expect(await authenticate(env, first.api_key)).toBeNull();
  const active = await principalOf(second.api_key);
  expect(active.pending).toBe(false);
  expect((await me(env, active)).account.email).toBe(EMAIL);
  expect(await getLatestOtp(env.DB, first.account_id)).toBeNull();
});

it("leaves the old key alone when the pending key gets the code wrong", async () => {
  const email = fakeEmail();
  const target = testEnv({ EMAIL: email.binding });
  const first = await signup(target, { email: EMAIL });
  const second = await signup(target, { email: EMAIL });
  const pending = await pendingPrincipalOf(second.api_key);

  await rejectsWith(verify(env, pending, { code: "999999" }), 400, "invalid_code");

  expect(await authenticate(env, first.api_key)).not.toBeNull();
  expect(await authenticate(env, second.api_key)).toBeNull();
  expect((await principalOf(first.api_key)).account.verified_at).toBeNull();
});

it("closes signup to addresses outside ALLOWED_SIGNUP_EMAILS", async () => {
  const email = fakeEmail();
  const target = testEnv({
    EMAIL: email.binding,
    ALLOWED_SIGNUP_EMAILS: ` ${EMAIL.toUpperCase()} , second@agents.test `,
  });

  const allowed = await signup(target, { email: EMAIL });
  expect(allowed.account_id.startsWith("acc_")).toBe(true);
  const other = await signup(target, { email: "second@agents.test" });
  expect(other.account_id.startsWith("acc_")).toBe(true);

  const closed = await rejectsWith(
    signup(target, { email: "stranger@agents.test" }, { ip: "203.0.113.9" }),
    403,
    "signup_closed",
  );
  expect(closed.message).toBe("signup is closed");
  expect(email.sent).toHaveLength(2);
});

it("leaves signup open when ALLOWED_SIGNUP_EMAILS is empty", async () => {
  const email = fakeEmail();
  const target = testEnv({ EMAIL: email.binding, ALLOWED_SIGNUP_EMAILS: "  ,  " });

  const result = await signup(target, { email: "stranger@agents.test" });

  expect(result.account_id.startsWith("acc_")).toBe(true);
  expect(result.key_pending).toBe(false);
});

it("rejects invalid emails and blocked domains", async () => {
  const email = fakeEmail();
  const target = testEnv({ EMAIL: email.binding });

  const invalid = await rejectsWith(signup(target, { email: "not-an-email" }), 400, "bad_request");
  expect(invalid.message).toBe("invalid email");
  await rejectsWith(signup(target, { email: "" }), 400, "bad_request");

  const blocked = await rejectsWith(
    signup(target, { email: "someone@example.com" }),
    400,
    "bad_request",
  );
  expect(blocked.message).toBe("email domain not allowed");
  expect(email.sent).toHaveLength(0);
});

it("rate limits by ip and skips the limiter without one", async () => {
  const email = fakeEmail();

  await rejectsWith(
    signup(
      testEnv({ EMAIL: email.binding, RATE: fakeRate(false) }),
      { email: EMAIL },
      {
        ip: "203.0.113.7",
      },
    ),
    429,
    "too_many_requests",
  );

  const allowed = await signup(
    testEnv({ EMAIL: email.binding, RATE: fakeRate(true) }),
    { email: EMAIL },
    { ip: "203.0.113.7" },
  );
  expect(allowed.otp_sent).toBe(true);

  const noIp = await signup(testEnv({ EMAIL: email.binding, RATE: fakeRate(false) }), {
    email: "second@agents.test",
  });
  expect(noIp.otp_sent).toBe(true);
});

it("refuses more codes than the hourly allowance", async () => {
  const email = fakeEmail();
  const target = testEnv({ EMAIL: email.binding });
  for (const _attempt of indexes(OTP_MAX_PER_HOUR)) {
    const result = await signup(target, { email: EMAIL });
    expect(result.otp_sent).toBe(true);
  }

  const failure = await rejectsWith(signup(target, { email: EMAIL }), 429, "too_many_requests");
  expect(failure.message).toBe("too many codes requested");
});

it("verifies with the emailed code and clears the otps", async () => {
  const email = fakeEmail();
  const result = await signup(testEnv({ EMAIL: email.binding }), { email: EMAIL });
  const principal = await principalOf(result.api_key);

  const verified = await verify(env, principal, { code: codeFrom(email) });

  expect(verified.account_id).toBe(result.account_id);
  expect(verified.verified).toBe(true);
  expect(verified.verified_at).toBeGreaterThan(0);
  expect(await getLatestOtp(env.DB, result.account_id)).toBeNull();

  const refreshed = await principalOf(result.api_key);
  expect(refreshed.account.verified_at).toBe(verified.verified_at);
  expect((await me(env, refreshed)).account.verified).toBe(true);

  const again = await verify(env, refreshed, { code: "000000" });
  expect(again.verified_at).toBe(verified.verified_at);
});

it("mails a fresh code even when the account is already verified", async () => {
  const email = fakeEmail();
  const result = await signup(testEnv({ EMAIL: email.binding }), { email: EMAIL });
  const principal = await principalOf(result.api_key);
  await verify(env, principal, { code: codeFrom(email) });

  const second = await signup(testEnv({ EMAIL: email.binding }), { email: EMAIL });

  expect(second.verified).toBe(true);
  expect(second.otp_sent).toBe(true);
  expect(second.key_pending).toBe(true);
  expect(email.sent).toHaveLength(2);
  expect(await getLatestOtp(env.DB, result.account_id)).not.toBeNull();
  expect(await authenticate(env, result.api_key)).not.toBeNull();
});

it("counts wrong codes and locks out after the attempt limit", async () => {
  const email = fakeEmail();
  const result = await signup(testEnv({ EMAIL: email.binding }), { email: EMAIL });
  const principal = await principalOf(result.api_key);

  for (const index of indexes(OTP_MAX_ATTEMPTS)) {
    const attempt = index + 1;
    const failure = await rejectsWith(
      verify(env, principal, { code: "999999" }),
      400,
      "invalid_code",
    );
    expect(failure.message).toBe("invalid code");
    expect((await getLatestOtp(env.DB, result.account_id))?.attempts).toBe(attempt);
  }

  const locked = await rejectsWith(
    verify(env, principal, { code: codeFrom(email) }),
    429,
    "too_many_requests",
  );
  expect(locked.message).toBe("too many attempts");
});

it("treats a missing or expired code as invalid", async () => {
  const email = fakeEmail();
  const result = await signup(testEnv({ EMAIL: email.binding }), { email: EMAIL });
  const principal = await principalOf(result.api_key);
  const code = codeFrom(email);

  await deleteOtps(env.DB, result.account_id);
  const missing = await rejectsWith(verify(env, principal, { code }), 400, "invalid_code");
  expect(missing.message).toBe("code expired");

  const expiredAt = now() - 1000;
  await insertOtp(env.DB, {
    accountId: result.account_id,
    codeHash: await sha256Hex(code),
    expiresAt: expiredAt,
    createdAt: expiredAt - 1000,
  });
  await rejectsWith(verify(env, principal, { code }), 400, "invalid_code");
  expect((await principalOf(result.api_key)).account.verified_at).toBeNull();
});
