import { env } from "cloudflare:test";
import { zipSync } from "fflate";
import { beforeEach, expect, it } from "vitest";
import { insertAccount } from "../src/db/accounts";
import { insertInbox } from "../src/db/inboxes";
import { getMessage } from "../src/db/messages";
import {
  InboundRejected,
  ingestInbound,
  REJECT_ATTACHMENT_TYPE,
  REJECT_SPAM,
} from "../src/email/inbound";
import { parseMime } from "../src/email/parse";
import { type SpamAssessment, scoreSpam } from "../src/email/spam";
import { resetDatabase } from "./support";

const ACCOUNT_ID = "acc_spam";

const INBOX_ID = "agent@intray.example";

const SENDER = "alice@example.com";

function bytes(text: string): Uint8Array {
  return new TextEncoder().encode(text.replace(/\r?\n/g, "\r\n"));
}

function base64(data: Uint8Array): string {
  const binary = Array.from(data, (byte) => String.fromCharCode(byte)).join("");
  return (btoa(binary).match(/.{1,76}/g) ?? []).join("\n");
}

async function score(raw: string, envelopeFrom = SENDER): Promise<SpamAssessment> {
  return scoreSpam(await parseMime(bytes(raw)), envelopeFrom);
}

const CLEAN = `Message-ID: <a1@example.com>
Date: Mon, 5 Jan 2026 10:00:00 +0000
From: Alice Example <alice@example.com>
To: agent@intray.example
Subject: Quarterly status

The status is green and the numbers land on Friday as usual.
`;

function withHeaders(extra: string, subject = "Quarterly status"): string {
  return `Message-ID: <a1@example.com>
Date: Mon, 5 Jan 2026 10:00:00 +0000
From: Alice Example <alice@example.com>
To: agent@intray.example
Subject: ${subject}
${extra}
The status is green and the numbers land on Friday as usual.
`;
}

function withHtml(html: string): string {
  return `Message-ID: <a1@example.com>
Date: Mon, 5 Jan 2026 10:00:00 +0000
From: Alice Example <alice@example.com>
To: agent@intray.example
Subject: Quarterly status
Content-Type: text/html; charset=utf-8

${html}
`;
}

function withText(text: string): string {
  return `Message-ID: <a1@example.com>
Date: Mon, 5 Jan 2026 10:00:00 +0000
From: Alice Example <alice@example.com>
To: agent@intray.example
Subject: Quarterly status

${text}
`;
}

function withAttachment(filename: string, contentType: string, body: string): string {
  return `Message-ID: <a1@example.com>
Date: Mon, 5 Jan 2026 10:00:00 +0000
From: Alice Example <alice@example.com>
To: agent@intray.example
Subject: Quarterly status
MIME-Version: 1.0
Content-Type: multipart/mixed; boundary="b1"

--b1
Content-Type: text/plain; charset=utf-8

The status is green and the numbers land on Friday as usual.

--b1
Content-Type: ${contentType}; name="${filename}"
Content-Disposition: attachment; filename="${filename}"
Content-Transfer-Encoding: base64

${body}

--b1--
`;
}

function zipAttachment(filename: string, entries: Record<string, string>): string {
  const encoder = new TextEncoder();
  const files = Object.fromEntries(
    Object.entries(entries).map(([name, content]) => [name, encoder.encode(content)]),
  );
  return withAttachment(filename, "application/zip", base64(zipSync(files)));
}

beforeEach(async () => {
  await resetDatabase(env.DB);
  await insertAccount(env.DB, { id: ACCOUNT_ID, email: "owner@example.com", createdAt: 1 });
  await insertInbox(env.DB, {
    inboxId: INBOX_ID,
    accountId: ACCOUNT_ID,
    username: "agent",
    domain: "intray.example",
    displayName: null,
    createdAt: 1,
  });
});

it("scores an ordinary message at zero", async () => {
  expect(await score(CLEAN)).toEqual({ score: 0, reasons: [] });
});

it("scores an Authentication-Results header that fails every method", async () => {
  const assessed = await score(
    withHeaders("Authentication-Results: mx.example.net; spf=fail; dkim=fail; dmarc=fail"),
  );
  expect(assessed.reasons).toEqual(["spf_fail", "dkim_fail", "dmarc_fail"]);
  expect(assessed.score).toBe(75);
});

it("scores a softfail and an absent DKIM result more gently", async () => {
  const assessed = await score(
    withHeaders("Authentication-Results: mx.example.net; spf=softfail; dkim=none"),
  );
  expect(assessed.reasons).toEqual(["spf_softfail", "dkim_none"]);
  expect(assessed.score).toBe(18);
});

it("reads several Authentication-Results instances whatever their case", async () => {
  const assessed = await score(
    withHeaders(
      `AUTHENTICATION-RESULTS: mx.example.net; spf=pass
Authentication-Results: mx.example.net; dmarc=fail`,
    ),
  );
  expect(assessed.reasons).toEqual(["dmarc_fail"]);
  expect(assessed.score).toBe(30);
});

it("ignores an absent Authentication-Results header", async () => {
  expect((await score(CLEAN)).reasons).not.toContain("spf_fail");
});

it("scores a missing Message-ID and a missing Date", async () => {
  const assessed = await score(`From: Alice Example <alice@example.com>
To: agent@intray.example
Subject: Quarterly status

The status is green and the numbers land on Friday as usual.
`);
  expect(assessed.reasons).toEqual(["missing_message_id", "missing_date"]);
  expect(assessed.score).toBe(15);
});

it("scores a display name holding an address the sender does not own", async () => {
  const assessed = await score(
    `Message-ID: <a1@example.com>
Date: Mon, 5 Jan 2026 10:00:00 +0000
From: "billing@example.com" <collector@example.net>
To: agent@intray.example
Subject: Quarterly status

The status is green and the numbers land on Friday as usual.
`,
    "collector@example.net",
  );
  expect(assessed.reasons).toEqual(["from_display_address"]);
  expect(assessed.score).toBe(20);
});

it("scores a Reply-To on another domain", async () => {
  const assessed = await score(withHeaders("Reply-To: replies@example.net"));
  expect(assessed.reasons).toEqual(["reply_to_other_domain"]);
  expect(assessed.score).toBe(10);
});

it("scores a From domain that is not the envelope sender's", async () => {
  const assessed = await score(CLEAN, "bounce@example.net");
  expect(assessed.reasons).toEqual(["from_not_envelope_domain"]);
  expect(assessed.score).toBe(12);
});

it("takes a subdomain of the envelope domain as the same domain", async () => {
  expect((await score(CLEAN, "alice@mail.example.com")).reasons).toEqual([]);
});

it("scores a shouted subject", async () => {
  const assessed = await score(withHeaders("", "URGENT ACTION REQUIRED NOW"));
  expect(assessed.reasons).toEqual(["subject_all_caps"]);
  expect(assessed.score).toBe(8);
});

it("scores a subject stuffed with exclamation marks and dollar signs", async () => {
  const assessed = await score(withHeaders("", "Win now!!! $$$"));
  expect(assessed.reasons).toEqual(["subject_punctuation"]);
  expect(assessed.score).toBe(8);
});

it("scores a reply prefix on a message that is in no thread", async () => {
  const assessed = await score(withHeaders("", "Re: your invoice"));
  expect(assessed.reasons).toEqual(["subject_fake_reply"]);
  expect(assessed.score).toBe(10);
});

it("leaves a real reply alone", async () => {
  const assessed = await score(
    withHeaders("In-Reply-To: <parent@example.com>", "Re: your invoice"),
  );
  expect(assessed.reasons).toEqual([]);
});

it("scores an html-only body whose visible text is thin and linked", async () => {
  const assessed = await score(
    withHtml('<html><body><a href="https://promo.example/win">Click</a></body></html>'),
  );
  expect(assessed.reasons).toEqual(["html_only", "html_thin_with_links"]);
  expect(assessed.score).toBe(18);
});

it("scores a body pointing at more link domains than a message needs", async () => {
  const assessed = await score(
    withText(
      `Please read the whole update before the meeting, the detail matters and the summary is
short on purpose so nobody has an excuse to skip it this quarter. The references are
https://one.example/a https://two.example/b https://three.example/c https://four.example/d
https://five.example/e https://six.example/f and they are all worth a look.`,
    ),
  );
  expect(assessed.reasons).toEqual(["many_link_domains"]);
  expect(assessed.score).toBe(8);
});

it("scores link text that shows one domain while the href points at another", async () => {
  const assessed = await score(
    withHtml(
      `<html><body><p>Your statement is ready and the balance carried over from last month is
unchanged, so there is nothing to approve before Friday.</p>
<a href="https://links.example.net/go">payments.example.com</a></body></html>`,
    ),
  );
  expect(assessed.reasons).toEqual(["html_only", "link_text_mismatch"]);
  expect(assessed.score).toBe(26);
});

it("scores a body that is mostly URLs", async () => {
  const assessed = await score(
    withText("https://one.example/a/long/path https://two.example/another/long/path see"),
  );
  expect(assessed.reasons).toEqual(["mostly_urls"]);
  expect(assessed.score).toBe(10);
});

it("scores bulk mail low and marks it as bulk", async () => {
  const assessed = await score(
    withHeaders(`List-Unsubscribe: <mailto:unsubscribe@example.com>
Precedence: bulk`),
  );
  expect(assessed.reasons).toEqual(["list_unsubscribe", "precedence_bulk"]);
  expect(assessed.score).toBe(8);
});

it("scores an executable attachment", async () => {
  const assessed = await score(
    withAttachment("setup.exe", "application/octet-stream", base64(new Uint8Array([1, 2, 3]))),
  );
  expect(assessed.reasons).toEqual(["attachment_executable"]);
  expect(assessed.score).toBe(60);
});

it("scores a double extension on top of the executable itself", async () => {
  const assessed = await score(
    withAttachment("invoice.pdf.exe", "application/octet-stream", base64(new Uint8Array([1, 2]))),
  );
  expect(assessed.reasons).toEqual(["attachment_executable", "attachment_double_extension"]);
  expect(assessed.score).toBe(100);
});

it("scores a script attachment without refusing it", async () => {
  const assessed = await score(
    withAttachment("deploy.sh", "application/octet-stream", base64(new Uint8Array([1, 2, 3]))),
  );
  expect(assessed.reasons).toEqual(["attachment_script"]);
  expect(assessed.score).toBe(30);
});

it("scores a macro-enabled Office document", async () => {
  const assessed = await score(
    withAttachment(
      "budget.xlsm",
      "application/vnd.ms-excel.sheet.macroEnabled.12",
      base64(new Uint8Array([1, 2])),
    ),
  );
  expect(assessed.reasons).toEqual(["attachment_macro_office"]);
  expect(assessed.score).toBe(25);
});

it("scores an executable inside a zip", async () => {
  const assessed = await score(
    zipAttachment("archive.zip", { "readme.txt": "hello", "payload.exe": "MZ" }),
  );
  expect(assessed.reasons).toEqual(["archive_executable"]);
  expect(assessed.score).toBe(60);
});

it("scores a script inside a zip without refusing it", async () => {
  const assessed = await score(
    zipAttachment("source.zip", { "readme.txt": "hello", "index.js": "export {};" }),
  );
  expect(assessed.reasons).toEqual(["attachment_script"]);
  expect(assessed.score).toBe(30);
});

it("leaves a zip of ordinary files alone", async () => {
  const assessed = await score(zipAttachment("docs.zip", { "notes.txt": "hello" }));
  expect(assessed.reasons).toEqual([]);
  expect(assessed.score).toBe(0);
});

it("scores a zip it cannot read as unknown", async () => {
  const assessed = await score(
    withAttachment("broken.zip", "application/zip", base64(new Uint8Array([1, 2, 3, 4, 5, 6]))),
  );
  expect(assessed.reasons).toEqual(["archive_unknown"]);
  expect(assessed.score).toBe(15);
});

it("caps the score at 100", async () => {
  const assessed = await score(
    `From: "billing@example.com" <collector@example.net>
To: agent@intray.example
Subject: RE: WIRE TRANSFER PENDING!!!! $$$$
Authentication-Results: mx.example.net; spf=fail; dkim=fail; dmarc=fail
Reply-To: replies@example.org

https://one.example/a/long/path https://two.example/another/long/path now
`,
    "bounce@example.com",
  );
  expect(assessed.score).toBe(100);
  expect(assessed.reasons.length).toBeGreaterThan(6);
});

it("labels a scored message spam and keeps it out of unread", async () => {
  const delivered = await ingestInbound(env, {
    envelopeFrom: SENDER,
    envelopeTo: INBOX_ID,
    raw: bytes(
      withHeaders("Authentication-Results: mx.example.net; spf=fail; dkim=fail; dmarc=fail"),
    ),
  });
  const row = await getMessage(env.DB, INBOX_ID, delivered.messageId);
  expect(row?.labels_json).toBe(JSON.stringify(["received", "spam"]));
  expect(row?.spam_score).toBe(75);
  expect(JSON.parse(row?.spam_reasons_json ?? "[]")).toEqual([
    "spf_fail",
    "dkim_fail",
    "dmarc_fail",
  ]);
});

it("stores an ordinary message unread with a zero score", async () => {
  const delivered = await ingestInbound(env, {
    envelopeFrom: SENDER,
    envelopeTo: INBOX_ID,
    raw: bytes(CLEAN),
  });
  const row = await getMessage(env.DB, INBOX_ID, delivered.messageId);
  expect(row?.labels_json).toBe(JSON.stringify(["received", "unread"]));
  expect(row?.spam_score).toBe(0);
  expect(row?.spam_reasons_json).toBe("[]");
});

it("keeps the subaddress tag on a message labelled spam", async () => {
  const delivered = await ingestInbound(env, {
    envelopeFrom: SENDER,
    envelopeTo: "agent+invoices@intray.example",
    raw: bytes(
      withHeaders("Authentication-Results: mx.example.net; spf=fail; dkim=fail; dmarc=fail"),
    ),
  });
  const row = await getMessage(env.DB, INBOX_ID, delivered.messageId);
  expect(row?.labels_json).toBe(JSON.stringify(["received", "spam", "invoices"]));
});

it("rejects a message at or above the reject threshold", async () => {
  const raw = bytes(`From: Alice Example <alice@example.com>
To: agent@intray.example
Subject: Quarterly status
Authentication-Results: mx.example.net; spf=fail; dkim=fail; dmarc=fail

The status is green and the numbers land on Friday as usual.
`);
  await expect(
    ingestInbound(env, { envelopeFrom: SENDER, envelopeTo: INBOX_ID, raw }),
  ).rejects.toThrow(InboundRejected);
  await expect(
    ingestInbound(env, { envelopeFrom: SENDER, envelopeTo: INBOX_ID, raw }),
  ).rejects.toThrow(REJECT_SPAM);
});

it("labels rather than rejects when the reject threshold is zero", async () => {
  const delivered = await ingestInbound(
    { ...env, SPAM_REJECT_THRESHOLD: "0" },
    {
      envelopeFrom: SENDER,
      envelopeTo: INBOX_ID,
      raw: bytes(`From: Alice Example <alice@example.com>
To: agent@intray.example
Subject: Quarterly status
Authentication-Results: mx.example.net; spf=fail; dkim=fail; dmarc=fail

The status is green and the numbers land on Friday as usual.
`),
    },
  );
  const row = await getMessage(env.DB, INBOX_ID, delivered.messageId);
  expect(row?.spam_score).toBe(90);
  expect(row?.labels_json).toBe(JSON.stringify(["received", "spam"]));
});

it("labels a low score when the operator lowers the label threshold", async () => {
  const delivered = await ingestInbound(
    { ...env, SPAM_LABEL_THRESHOLD: "5" },
    {
      envelopeFrom: SENDER,
      envelopeTo: INBOX_ID,
      raw: bytes(withHeaders("Precedence: bulk")),
    },
  );
  const row = await getMessage(env.DB, INBOX_ID, delivered.messageId);
  expect(row?.spam_score).toBe(5);
  expect(row?.labels_json).toBe(JSON.stringify(["received", "spam"]));
});

it("rejects an executable attachment whatever the thresholds say", async () => {
  await expect(
    ingestInbound(
      { ...env, SPAM_REJECT_THRESHOLD: "0", SPAM_LABEL_THRESHOLD: "100" },
      {
        envelopeFrom: SENDER,
        envelopeTo: INBOX_ID,
        raw: bytes(
          withAttachment("setup.exe", "application/octet-stream", base64(new Uint8Array([1, 2]))),
        ),
      },
    ),
  ).rejects.toThrow(REJECT_ATTACHMENT_TYPE);
});

it("rejects an executable found inside a zip and stores nothing", async () => {
  await expect(
    ingestInbound(env, {
      envelopeFrom: SENDER,
      envelopeTo: INBOX_ID,
      raw: bytes(zipAttachment("archive.zip", { "payload.exe": "MZ" })),
    }),
  ).rejects.toThrow(REJECT_ATTACHMENT_TYPE);
});

it("stores a zip of source code with its score and reason", async () => {
  const delivered = await ingestInbound(env, {
    envelopeFrom: SENDER,
    envelopeTo: INBOX_ID,
    raw: bytes(zipAttachment("source.zip", { "index.js": "export {};" })),
  });
  const row = await getMessage(env.DB, INBOX_ID, delivered.messageId);
  expect(row?.spam_score).toBe(30);
  expect(row?.spam_reasons_json).toBe(JSON.stringify(["attachment_script"]));
  expect(row?.has_attachments).toBe(1);
});

it("accepts a zip of ordinary files", async () => {
  const delivered = await ingestInbound(env, {
    envelopeFrom: SENDER,
    envelopeTo: INBOX_ID,
    raw: bytes(zipAttachment("docs.zip", { "notes.txt": "hello" })),
  });
  const row = await getMessage(env.DB, INBOX_ID, delivered.messageId);
  expect(row?.spam_score).toBe(0);
  expect(row?.has_attachments).toBe(1);
});
