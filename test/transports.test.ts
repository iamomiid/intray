import { env } from "cloudflare:test";
import { afterEach, expect, it, vi } from "vitest";
import { parseMime } from "../src/email/parse";
import { sendOtpEmail } from "../src/email/system";
import type { MailTransport, OutboundMessage } from "../src/email/transport";
import { toEmailMessageBuilder } from "../src/email/transports/cloudflare";
import { selectTransport } from "../src/email/transports/index";
import { serializeMime } from "../src/email/transports/mime";
import { resendTransport } from "../src/email/transports/resend";
import { sesTransport } from "../src/email/transports/ses";
import { type SocketConnect, smtpTransport } from "../src/email/transports/smtp";
import type { Env } from "../src/env";
import { AppError } from "../src/lib/errors";
import { base64Decode } from "../src/lib/hash";

const EXAMPLE_ID = "AKIDEXAMPLE";

const EXAMPLE_VALUE = "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY";

const SMTP_USER = "postmaster@intray.example";

const SMTP_WORD = "not-a-real-password";

const RESEND_KEY = "re_example_not_a_real_key";

const NUL = String.fromCharCode(0);

const decoder = new TextDecoder();

interface FakeSocketScript {
  written: string[];
  upgraded: boolean;
}

function message(overrides: Partial<OutboundMessage> = {}): OutboundMessage {
  return {
    from: { name: "Agent", email: "agent@intray.example" },
    to: ["bob@example.com"],
    cc: [],
    bcc: [],
    replyTo: null,
    subject: "Status please",
    text: "Any update?",
    html: null,
    headers: {},
    attachments: [],
    inReplyTo: null,
    references: [],
    ...overrides,
  };
}

async function rejectsWith(promise: Promise<unknown>, status: number, code: string): Promise<void> {
  await expect(promise).rejects.toBeInstanceOf(AppError);
  await promise.catch((error: unknown) => {
    const failure = error as AppError;
    expect(failure.status).toBe(status);
    expect(failure.code).toBe(code);
  });
}

function scriptedSocket(replies: string[], script: FakeSocketScript): Socket {
  const encoder = new TextEncoder();
  const pending = [...replies];
  const readable = new ReadableStream<Uint8Array>({
    pull(controller) {
      const next = pending.shift();
      if (next === undefined) {
        controller.close();
        return;
      }
      controller.enqueue(encoder.encode(next));
    },
  });
  const writable = new WritableStream<Uint8Array>({
    write(chunk) {
      script.written.push(decoder.decode(chunk));
    },
  });
  const socket = {
    readable,
    writable,
    closed: Promise.resolve(),
    opened: Promise.resolve({ remoteAddress: "", localAddress: "" }),
    close: (): Promise<void> => Promise.resolve(),
    upgraded: false,
    secureTransport: "on" as const,
    startTls: (): Socket => {
      script.upgraded = true;
      return socket;
    },
  };
  return socket as unknown as Socket;
}

function fakeConnect(
  replies: string[],
  script: FakeSocketScript,
): { connect: SocketConnect; addresses: SocketAddress[]; options: (SocketOptions | undefined)[] } {
  const addresses: SocketAddress[] = [];
  const options: (SocketOptions | undefined)[] = [];
  return {
    addresses,
    options,
    connect: (address: SocketAddress, option?: SocketOptions): Socket => {
      addresses.push(address);
      options.push(option);
      return scriptedSocket(replies, script);
    },
  };
}

function commands(script: FakeSocketScript): string[] {
  return script.written
    .join("")
    .split("\r\n")
    .filter((line) => line.length > 0);
}

function smtpSettings(security: "tls" | "starttls") {
  return {
    host: "smtp.example.com",
    port: security === "tls" ? 465 : 587,
    username: SMTP_USER,
    password: SMTP_WORD,
    security,
    ehloName: "intray.example",
  };
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function sesSettings() {
  return {
    region: "us-east-1",
    accessKeyId: EXAMPLE_ID,
    secretAccessKey: EXAMPLE_VALUE,
    sessionToken: null,
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

it("serializes a text and html message postal-mime reads back", async () => {
  const serialized = serializeMime(
    message({ html: "<p>Any update?</p>", subject: "État des lieux" }),
    new Date(Date.UTC(2026, 8, 8, 15, 0, 0)),
  );
  const raw = decoder.decode(serialized.raw);
  expect(raw).toContain("MIME-Version: 1.0");
  expect(raw).toContain("Date: Tue, 08 Sep 2026 15:00:00 +0000");
  expect(raw).toContain("multipart/alternative");
  expect(raw).toContain("=?UTF-8?B?");
  expect(raw).toContain(`Message-ID: <${serialized.messageId}>`);
  expect(serialized.messageId.endsWith("@intray.example")).toBe(true);

  const parsed = await parseMime(serialized.raw);
  expect(parsed.from).toEqual({ address: "agent@intray.example", name: "Agent" });
  expect(parsed.to).toEqual([{ address: "bob@example.com", name: null }]);
  expect(parsed.subject).toBe("État des lieux");
  expect(parsed.text?.trim()).toBe("Any update?");
  expect(parsed.html?.trim()).toBe("<p>Any update?</p>");
  expect(parsed.messageId).toBe(serialized.messageId);
});

it("serializes attachments and threading headers postal-mime reads back", async () => {
  const serialized = serializeMime(
    message({
      cc: ["carol@example.com"],
      replyTo: "desk@intray.example",
      subject: "Re: Quarterly status",
      inReplyTo: "plain-001@example.com",
      references: ["chain-001@example.com", "plain-001@example.com"],
      headers: { "X-Intray-Tag": "invoices" },
      attachments: [
        {
          filename: "note.txt",
          contentType: "text/plain",
          content: new TextEncoder().encode("attached note body"),
        },
      ],
    }),
  );
  const raw = decoder.decode(serialized.raw);
  expect(raw).toContain("multipart/mixed");
  expect(raw).toContain("X-Intray-Tag: invoices");

  const parsed = await parseMime(serialized.raw);
  expect(parsed.cc).toEqual([{ address: "carol@example.com", name: null }]);
  expect(parsed.replyTo).toEqual({ address: "desk@intray.example", name: null });
  expect(parsed.inReplyTo).toBe("plain-001@example.com");
  expect(parsed.references).toEqual(["chain-001@example.com", "plain-001@example.com"]);
  expect(parsed.attachments).toHaveLength(1);
  expect(parsed.attachments[0]?.filename).toBe("note.txt");
  expect(decoder.decode(parsed.attachments[0]?.content)).toBe("attached note body");
});

it("keeps a message id the caller set", () => {
  const serialized = serializeMime(message({ headers: { "Message-ID": "<given-1@example.com>" } }));
  expect(serialized.messageId).toBe("given-1@example.com");
  expect(decoder.decode(serialized.raw)).toContain("Message-ID: <given-1@example.com>");
});

it("renders an outbound message into a send binding builder", () => {
  const builder = toEmailMessageBuilder(
    message({ cc: ["carol@example.com"], bcc: ["dave@example.com"], html: "<p>hi</p>" }),
  );
  expect(builder.from).toEqual({ name: "Agent", email: "agent@intray.example" });
  expect(builder.to).toEqual(["bob@example.com"]);
  expect(builder.cc).toEqual(["carol@example.com"]);
  expect(builder.bcc).toEqual(["dave@example.com"]);
  expect(builder.html).toBe("<p>hi</p>");
  expect(builder.headers).toBeUndefined();
});

it("walks the smtp transaction over implicit tls", async () => {
  const script: FakeSocketScript = { written: [], upgraded: false };
  const socket = fakeConnect(
    [
      "220 smtp.example.com ESMTP\r\n",
      "250-smtp.example.com\r\n250 AUTH PLAIN LOGIN\r\n",
      "235 accepted\r\n",
      "250 sender ok\r\n",
      "250 recipient ok\r\n",
      "250 recipient ok\r\n",
      "354 go ahead\r\n",
      "250 queued\r\n",
      "221 bye\r\n",
    ],
    script,
  );
  const messageId = await smtpTransport(smtpSettings("tls"), socket.connect).send(
    message({ cc: ["carol@example.com"] }),
  );

  expect(socket.addresses[0]).toEqual({ hostname: "smtp.example.com", port: 465 });
  expect(socket.options[0]?.secureTransport).toBe("on");
  expect(script.upgraded).toBe(false);
  expect(commands(script).slice(0, 2)).toEqual([
    "EHLO intray.example",
    `AUTH PLAIN ${btoa(`${NUL}${SMTP_USER}${NUL}${SMTP_WORD}`)}`,
  ]);
  expect(commands(script).slice(2, 6)).toEqual([
    "MAIL FROM:<agent@intray.example>",
    "RCPT TO:<bob@example.com>",
    "RCPT TO:<carol@example.com>",
    "DATA",
  ]);
  expect(script.written.join("")).toContain(`Message-ID: <${messageId}>`);
  expect(script.written.join("")).toContain("\r\n.\r\n");
  expect(commands(script).at(-1)).toBe("QUIT");
});

it("upgrades with starttls and re-greets", async () => {
  const script: FakeSocketScript = { written: [], upgraded: false };
  const socket = fakeConnect(
    [
      "220 smtp.example.com ESMTP\r\n",
      "250-smtp.example.com\r\n250 STARTTLS\r\n",
      "220 ready to start tls\r\n",
      "250-smtp.example.com\r\n250 AUTH LOGIN\r\n",
      "334 VXNlcm5hbWU6\r\n",
      "334 UGFzc3dvcmQ6\r\n",
      "235 accepted\r\n",
      "250 sender ok\r\n",
      "250 recipient ok\r\n",
      "354 go ahead\r\n",
      "250 queued\r\n",
      "221 bye\r\n",
    ],
    script,
  );
  await smtpTransport(smtpSettings("starttls"), socket.connect).send(message());

  expect(socket.options[0]?.secureTransport).toBe("starttls");
  expect(script.upgraded).toBe(true);
  expect(commands(script).slice(0, 6)).toEqual([
    "EHLO intray.example",
    "STARTTLS",
    "EHLO intray.example",
    "AUTH LOGIN",
    btoa(SMTP_USER),
    btoa(SMTP_WORD),
  ]);
});

it("maps smtp rejections onto the send contract", async () => {
  const refusedSender: FakeSocketScript = { written: [], upgraded: false };
  await rejectsWith(
    smtpTransport(
      smtpSettings("tls"),
      fakeConnect(
        ["220 ok\r\n", "250 AUTH PLAIN\r\n", "235 accepted\r\n", "550 sender not allowed\r\n"],
        refusedSender,
      ).connect,
    ).send(message()),
    503,
    "sender_not_verified",
  );

  const deferred: FakeSocketScript = { written: [], upgraded: false };
  await rejectsWith(
    smtpTransport(
      smtpSettings("tls"),
      fakeConnect(
        ["220 ok\r\n", "250 AUTH PLAIN\r\n", "235 accepted\r\n", "450 slow down\r\n"],
        deferred,
      ).connect,
    ).send(message()),
    429,
    "too_many_requests",
  );

  const refusedRecipient: FakeSocketScript = { written: [], upgraded: false };
  await rejectsWith(
    smtpTransport(
      smtpSettings("tls"),
      fakeConnect(
        [
          "220 ok\r\n",
          "250 AUTH PLAIN\r\n",
          "235 accepted\r\n",
          "250 sender ok\r\n",
          "550 no such user\r\n",
        ],
        refusedRecipient,
      ).connect,
    ).send(message()),
    400,
    "recipient_suppressed",
  );

  const refusedData: FakeSocketScript = { written: [], upgraded: false };
  await rejectsWith(
    smtpTransport(
      smtpSettings("tls"),
      fakeConnect(
        [
          "220 ok\r\n",
          "250 AUTH PLAIN\r\n",
          "235 accepted\r\n",
          "250 sender ok\r\n",
          "250 recipient ok\r\n",
          "354 go ahead\r\n",
          "554 message content rejected\r\n",
        ],
        refusedData,
      ).connect,
    ).send(message()),
    400,
    "message_rejected",
  );
});

it("posts a signed raw message to ses", async () => {
  const calls: { url: string; init: RequestInit | undefined }[] = [];
  vi.stubGlobal("fetch", (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    return Promise.resolve(jsonResponse(200, { MessageId: "0100019" }));
  });

  const messageId = await sesTransport(sesSettings()).send(message());

  expect(calls[0]?.url).toBe("https://email.us-east-1.amazonaws.com/v2/email/outbound-emails");
  const headers = calls[0]?.init?.headers as Record<string, string>;
  expect(headers.authorization).toContain(`AWS4-HMAC-SHA256 Credential=${EXAMPLE_ID}/`);
  expect(headers.authorization).toContain("/us-east-1/ses/aws4_request");
  expect(headers.host).toBeUndefined();
  expect(headers["x-amz-date"]).toMatch(/^\d{8}T\d{6}Z$/);
  const body = JSON.parse(String(calls[0]?.init?.body)) as { Content: { Raw: { Data: string } } };
  expect(decoder.decode(base64Decode(body.Content.Raw.Data))).toContain(
    `Message-ID: <${messageId}>`,
  );
});

it("maps ses rejections onto the send contract", async () => {
  const answer = (status: number, payload: unknown): void => {
    vi.stubGlobal("fetch", () => Promise.resolve(jsonResponse(status, payload)));
  };

  answer(400, { __type: "MessageRejected", message: "Message content rejected" });
  await rejectsWith(sesTransport(sesSettings()).send(message()), 400, "message_rejected");

  answer(400, { __type: "MailFromDomainNotVerified", message: "domain is not set up" });
  await rejectsWith(sesTransport(sesSettings()).send(message()), 503, "sender_not_verified");

  answer(429, { __type: "TooManyRequestsException", message: "Maximum sending rate exceeded" });
  await rejectsWith(sesTransport(sesSettings()).send(message()), 429, "too_many_requests");

  answer(400, {
    __type: "AccountSuppressionListException",
    message: "the address is on the account suppression list",
  });
  await rejectsWith(sesTransport(sesSettings()).send(message()), 400, "recipient_suppressed");
});

it("posts json to resend and carries its own message id", async () => {
  const calls: RequestInit[] = [];
  vi.stubGlobal("fetch", (_url: string, init: RequestInit) => {
    calls.push(init);
    return Promise.resolve(jsonResponse(200, { id: "sent" }));
  });

  const messageId = await resendTransport({ apiKey: RESEND_KEY }).send(
    message({
      cc: ["carol@example.com"],
      inReplyTo: "plain-001@example.com",
      references: ["plain-001@example.com"],
      attachments: [
        {
          filename: "note.txt",
          contentType: "text/plain",
          content: new TextEncoder().encode("bytes"),
        },
      ],
    }),
  );

  const headers = calls[0]?.headers as Record<string, string>;
  expect(headers.authorization).toBe(`Bearer ${RESEND_KEY}`);
  const body = JSON.parse(String(calls[0]?.body)) as Record<string, unknown>;
  expect(body.from).toBe("Agent <agent@intray.example>");
  expect(body.to).toEqual(["bob@example.com"]);
  expect(body.cc).toEqual(["carol@example.com"]);
  expect(body.headers).toEqual({
    "In-Reply-To": "<plain-001@example.com>",
    References: "<plain-001@example.com>",
    "Message-ID": `<${messageId}>`,
  });
  expect(body.attachments).toEqual([
    { filename: "note.txt", content: btoa("bytes"), content_type: "text/plain" },
  ]);
});

it("maps resend rejections onto the send contract", async () => {
  const answer = (status: number, payload: unknown): void => {
    vi.stubGlobal("fetch", () => Promise.resolve(jsonResponse(status, payload)));
  };

  answer(422, { message: "The intray.example domain is not verified" });
  await rejectsWith(
    resendTransport({ apiKey: RESEND_KEY }).send(message()),
    503,
    "sender_not_verified",
  );

  answer(429, { message: "Too many requests" });
  await rejectsWith(
    resendTransport({ apiKey: RESEND_KEY }).send(message()),
    429,
    "too_many_requests",
  );

  answer(400, { message: "Invalid attachment" });
  await rejectsWith(
    resendTransport({ apiKey: RESEND_KEY }).send(message()),
    400,
    "message_rejected",
  );
});

it("selects the transport MAIL_TRANSPORT names", () => {
  expect(selectTransport(env)).toBeDefined();
  expect(
    selectTransport({ ...env, MAIL_TRANSPORT: "resend", RESEND_API_KEY: RESEND_KEY }),
  ).toBeDefined();
  expect(() => selectTransport({ ...env, MAIL_TRANSPORT: "postal" })).toThrow(
    "MAIL_TRANSPORT postal is not one of cloudflare, smtp, ses, resend",
  );
});

it("fails a send with the name of the missing secret", () => {
  const missing = (overrides: Partial<Env>): AppError => {
    try {
      selectTransport({ ...env, ...overrides });
    } catch (error) {
      return error as AppError;
    }
    throw new Error("expected a failure");
  };

  const resend = missing({ MAIL_TRANSPORT: "resend" });
  expect(resend.status).toBe(503);
  expect(resend.code).toBe("sender_not_verified");
  expect(resend.message).toBe("MAIL_TRANSPORT is resend but RESEND_API_KEY is not set");

  expect(missing({ MAIL_TRANSPORT: "smtp", SMTP_HOST: "smtp.example.com" }).message).toBe(
    "MAIL_TRANSPORT is smtp but SMTP_USERNAME is not set",
  );
  expect(
    missing({ MAIL_TRANSPORT: "ses", AWS_REGION: "us-east-1", AWS_ACCESS_KEY_ID: EXAMPLE_ID })
      .message,
  ).toBe("MAIL_TRANSPORT is ses but AWS_SECRET_ACCESS_KEY is not set");
});

it("sends the otp mail through the selected transport", async () => {
  const sent: OutboundMessage[] = [];
  const transport: MailTransport = {
    send: (outbound: OutboundMessage): Promise<string | null> => {
      sent.push(outbound);
      return Promise.resolve("otp-1@intray.example");
    },
  };
  await sendOtpEmail(
    { ...env, MAIL_TRANSPORT: "resend", MAIL: transport },
    {
      to: "human@agents.test",
      code: "123456",
    },
  );

  expect(sent).toHaveLength(1);
  expect(sent[0]?.from).toEqual({ name: "intray", email: "noreply@intray.example" });
  expect(sent[0]?.to).toEqual(["human@agents.test"]);
  expect(sent[0]?.subject).toBe("123456 is your intray verification code");
  expect(sent[0]?.text).toContain("123456 is your intray verification code.");
  expect(sent[0]?.html).toContain("<strong>123456</strong>");
});
