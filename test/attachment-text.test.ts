import { env, SELF } from "cloudflare:test";
import { zipSync } from "fflate";
import { beforeEach, expect, it } from "vitest";
import { getAttachmentText, listAttachments } from "../src/core/attachments";
import { sendMessage } from "../src/core/messages";
import type { Principal } from "../src/core/principal";
import { insertAccount, markAccountVerified } from "../src/db/accounts";
import { insertInbox } from "../src/db/inboxes";
import { extractText } from "../src/email/extract";
import { ingestInbound } from "../src/email/inbound";
import type { Env } from "../src/env";
import { AppError } from "../src/lib/errors";
import { ATTACHMENT_TEXT_MAX_BYTES, ATTACHMENT_TEXT_MAX_INPUT_BYTES } from "../src/lib/limits";
import { resetDatabase } from "./support";

const ACCOUNT_ID = "acc_attachment_text";
const INBOX_ID = "agent@intray.example";
const OWNER_EMAIL = "owner@example.com";
const HUMAN = "human@agents.test";

const PDF_CONTENT_TYPE = "application/pdf";
const DOCX_CONTENT_TYPE = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

const encoder = new TextEncoder();

interface MimePart {
  filename: string;
  contentType: string;
  content: Uint8Array;
}

function principalFor(verified: boolean): Principal {
  return {
    account: {
      id: ACCOUNT_ID,
      email: OWNER_EMAIL,
      verified_at: verified ? 1 : null,
      created_at: 1,
    },
    keyId: "key_attachment_text",
    pending: false,
  };
}

function fakeEmail(): Env {
  return {
    ...env,
    EMAIL: {
      send: (): Promise<EmailSendResult> => Promise.resolve({ messageId: "<out-1@example.com>" }),
    },
  };
}

function minimalPdf(body: string): Uint8Array {
  const content = `BT /F1 24 Tf 72 700 Td (${body}) Tj ET\n`;
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
    `<< /Length ${content.length} >>\nstream\n${content}endstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  const header = "%PDF-1.4\n";
  const bodies = objects.map((object, index) => `${index + 1} 0 obj\n${object}\nendobj\n`);
  const offsets = bodies.reduce<number[]>(
    (acc, chunk) => [...acc, (acc[acc.length - 1] ?? 0) + chunk.length],
    [header.length],
  );
  const entries = offsets
    .slice(0, objects.length)
    .map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`)
    .join("");
  const xref = `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${entries}`;
  const startxref = offsets[offsets.length - 1] ?? 0;
  const trailer = `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${startxref}\n%%EOF\n`;
  return encoder.encode(`${header}${bodies.join("")}${xref}${trailer}`);
}

function minimalDocx(paragraphs: string[]): Uint8Array {
  const runs = paragraphs
    .map((paragraph) => `<w:p><w:r><w:t xml:space="preserve">${paragraph}</w:t></w:r></w:p>`)
    .join("");
  const namespace = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";
  const document = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="${namespace}"><w:body>${runs}</w:body></w:document>`;
  const contentTypes = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>`;
  const relationships = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>`;
  return zipSync({
    "[Content_Types].xml": encoder.encode(contentTypes),
    "_rels/.rels": encoder.encode(relationships),
    "word/document.xml": encoder.encode(document),
  });
}

function base64Of(content: Uint8Array): string {
  const binary = Array.from(content, (byte) => String.fromCharCode(byte)).join("");
  return (btoa(binary).match(/.{1,76}/g) ?? []).join("\n");
}

function mimeWith(parts: MimePart[]): Uint8Array {
  const boundary = "intray-attachment-text";
  const attachments = parts.map((part) =>
    [
      `--${boundary}`,
      `Content-Type: ${part.contentType}; name="${part.filename}"`,
      "Content-Transfer-Encoding: base64",
      `Content-Disposition: attachment; filename="${part.filename}"`,
      "",
      base64Of(part.content),
      "",
    ].join("\n"),
  );
  const source = [
    "From: Carol <carol@example.com>",
    `To: ${INBOX_ID}`,
    "Subject: Documents",
    "Message-ID: <documents-1@example.com>",
    "MIME-Version: 1.0",
    `Content-Type: multipart/mixed; boundary="${boundary}"`,
    "",
    `--${boundary}`,
    "Content-Type: text/plain; charset=utf-8",
    "",
    "See attached.",
    "",
    ...attachments,
    `--${boundary}--`,
    "",
  ].join("\n");
  return encoder.encode(source.replace(/\r?\n/g, "\r\n"));
}

function deliver(parts: MimePart[]) {
  return ingestInbound(env, {
    envelopeFrom: "carol@example.com",
    envelopeTo: INBOX_ID,
    raw: mimeWith(parts),
  });
}

async function signupOver(): Promise<{ api_key: string; inbox_id: string; account_id: string }> {
  const response = await SELF.fetch("http://intray.test/v1/agent/signup", {
    method: "POST",
    body: JSON.stringify({ email: HUMAN }),
  });
  expect(response.status).toBe(201);
  return response.json();
}

beforeEach(async () => {
  await resetDatabase(env.DB);
  await insertAccount(env.DB, { id: ACCOUNT_ID, email: OWNER_EMAIL, createdAt: 1 });
  await insertInbox(env.DB, {
    inboxId: INBOX_ID,
    accountId: ACCOUNT_ID,
    username: "agent",
    domain: "intray.example",
    displayName: "Agent",
    createdAt: 1,
  });
});

it("extracts text from a pdf by content type and by filename", async () => {
  const pdf = minimalPdf("Quarterly figures attached");

  const byType = await extractText(PDF_CONTENT_TYPE, "report", pdf);
  expect(byType.status).toBe("extracted");
  expect(byType.text).toContain("Quarterly figures attached");

  const byName = await extractText("application/octet-stream", "Report.PDF", pdf);
  expect(byName.status).toBe("extracted");
  expect(byName.text).toContain("Quarterly figures attached");
});

it("extracts docx paragraphs and keeps the breaks between them", async () => {
  const docx = minimalDocx(["First paragraph.", "Second   paragraph.", "Third paragraph."]);

  const byType = await extractText(DOCX_CONTENT_TYPE, "notes", docx);
  expect(byType.status).toBe("extracted");
  expect(byType.text).toBe("First paragraph.\nSecond paragraph.\nThird paragraph.");

  const byName = await extractText(null, "notes.docx", docx);
  expect(byName.text).toBe(byType.text);
});

it("reports an unsupported attachment type as none", async () => {
  const plain = await extractText("text/plain", "note.txt", encoder.encode("hello"));
  expect(plain).toEqual({ status: "none", text: null });

  const image = await extractText("image/png", null, encoder.encode("not a png"));
  expect(image).toEqual({ status: "none", text: null });
});

it("reports a corrupt pdf as failed and an empty document as empty", async () => {
  const corrupt = await extractText(
    PDF_CONTENT_TYPE,
    "broken.pdf",
    encoder.encode("%PDF-1.4 nope"),
  );
  expect(corrupt).toEqual({ status: "failed", text: null });

  const blank = await extractText(DOCX_CONTENT_TYPE, "blank.docx", minimalDocx([]));
  expect(blank).toEqual({ status: "empty", text: null });
});

it("skips an input over the size cap", async () => {
  const sparse = new Uint8Array(ATTACHMENT_TEXT_MAX_INPUT_BYTES + 1);
  const result = await extractText(PDF_CONTENT_TYPE, "huge.pdf", sparse);
  expect(result).toEqual({ status: "too_large", text: null });
});

it("caps the extracted text at the output limit", async () => {
  const paragraph = "a".repeat(1000);
  const docx = minimalDocx(Array.from({ length: 400 }, () => paragraph));

  const result = await extractText(DOCX_CONTENT_TYPE, "long.docx", docx);
  expect(result.status).toBe("extracted");
  const encoded = encoder.encode(result.text ?? "");
  expect(encoded.byteLength).toBeGreaterThan(ATTACHMENT_TEXT_MAX_BYTES - 4);
  expect(encoded.byteLength).toBeLessThanOrEqual(ATTACHMENT_TEXT_MAX_BYTES);
});

it("stores the extracted text and status on ingest", async () => {
  const ingested = await deliver([
    { filename: "report.pdf", contentType: PDF_CONTENT_TYPE, content: minimalPdf("Ingested body") },
    {
      filename: "notes.docx",
      contentType: DOCX_CONTENT_TYPE,
      content: minimalDocx(["Docx line one.", "Docx line two."]),
    },
    { filename: "note.txt", contentType: "text/plain", content: encoder.encode("plain") },
  ]);

  const rows = await env.DB.prepare(
    "SELECT filename, text, text_status FROM attachments WHERE message_id = ? ORDER BY rowid ASC",
  )
    .bind(ingested.messageId)
    .all<{ filename: string; text: string | null; text_status: string }>();

  expect(rows.results.map((row) => [row.filename, row.text_status])).toEqual([
    ["report.pdf", "extracted"],
    ["notes.docx", "extracted"],
    ["note.txt", "none"],
  ]);
  expect(rows.results[0]?.text).toContain("Ingested body");
  expect(rows.results[1]?.text).toBe("Docx line one.\nDocx line two.");
  expect(rows.results[2]?.text).toBeNull();
});

it("ingests a message whose pdf cannot be parsed", async () => {
  const ingested = await deliver([
    {
      filename: "broken.pdf",
      contentType: PDF_CONTENT_TYPE,
      content: encoder.encode("%PDF-1.4 truncated and invalid"),
    },
  ]);

  const attachments = await listAttachments(env, principalFor(false), INBOX_ID, ingested.messageId);
  expect(attachments).toHaveLength(1);
  const broken = attachments[0]?.attachment_id ?? "";
  expect(attachments[0]?.text_status).toBe("failed");
  await expect(
    getAttachmentText(env, principalFor(false), INBOX_ID, ingested.messageId, broken),
  ).rejects.toBeInstanceOf(AppError);
});

it("puts text_status but never text on the attachments embedded in a message", async () => {
  const account = await signupOver();
  const auth = { authorization: `Bearer ${account.api_key}` };
  const ingested = await ingestInbound(env, {
    envelopeFrom: "carol@example.com",
    envelopeTo: account.inbox_id,
    raw: mimeWith([
      {
        filename: "report.pdf",
        contentType: PDF_CONTENT_TYPE,
        content: minimalPdf("Embedded body"),
      },
    ]),
  });
  const base = `http://intray.test/v1/inboxes/${encodeURIComponent(account.inbox_id)}`;

  const response = await SELF.fetch(`${base}/messages/${ingested.messageId}`, { headers: auth });
  expect(response.status).toBe(200);
  const message = await response.json<{
    attachments: Record<string, unknown>[];
  }>();
  expect(message.attachments).toHaveLength(1);
  expect(message.attachments[0]?.text_status).toBe("extracted");
  expect(message.attachments[0]).not.toHaveProperty("text");

  const listed = await SELF.fetch(`${base}/messages`, { headers: auth });
  const page = await listed.json<{ items: { attachments: Record<string, unknown>[] }[] }>();
  expect(page.items[0]?.attachments[0]?.text_status).toBe("extracted");
  expect(page.items[0]?.attachments[0]).not.toHaveProperty("text");
});

it("serves the extracted text over http and 404s when there is none", async () => {
  const account = await signupOver();
  const auth = { authorization: `Bearer ${account.api_key}` };
  const ingested = await ingestInbound(env, {
    envelopeFrom: "carol@example.com",
    envelopeTo: account.inbox_id,
    raw: mimeWith([
      { filename: "report.pdf", contentType: PDF_CONTENT_TYPE, content: minimalPdf("Route body") },
      { filename: "note.txt", contentType: "text/plain", content: encoder.encode("plain") },
    ]),
  });
  const base = `http://intray.test/v1/inboxes/${encodeURIComponent(account.inbox_id)}`;

  const message = await (
    await SELF.fetch(`${base}/messages/${ingested.messageId}`, { headers: auth })
  ).json<{ attachments: { attachment_id: string; filename: string | null }[] }>();
  const pdf = message.attachments.find((entry) => entry.filename === "report.pdf");
  const note = message.attachments.find((entry) => entry.filename === "note.txt");

  const text = await SELF.fetch(
    `${base}/messages/${ingested.messageId}/attachments/${pdf?.attachment_id}/text`,
    { headers: auth },
  );
  expect(text.status).toBe(200);
  expect(text.headers.get("content-type")).toBe("text/plain; charset=utf-8");
  expect(await text.text()).toContain("Route body");

  const missing = await SELF.fetch(
    `${base}/messages/${ingested.messageId}/attachments/${note?.attachment_id}/text`,
    { headers: auth },
  );
  expect(missing.status).toBe(404);

  const unknown = await SELF.fetch(
    `${base}/messages/${ingested.messageId}/attachments/att_nothing/text`,
    { headers: auth },
  );
  expect(unknown.status).toBe(404);
});

it("returns the extracted text from get_attachment over mcp", async () => {
  const account = await signupOver();
  const ingested = await ingestInbound(env, {
    envelopeFrom: "carol@example.com",
    envelopeTo: account.inbox_id,
    raw: mimeWith([
      { filename: "report.pdf", contentType: PDF_CONTENT_TYPE, content: minimalPdf("Tool body") },
    ]),
  });
  const rows = await env.DB.prepare("SELECT attachment_id FROM attachments WHERE message_id = ?")
    .bind(ingested.messageId)
    .all<{ attachment_id: string }>();

  const response = await SELF.fetch("http://intray.test/mcp", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      authorization: `Bearer ${account.api_key}`,
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: {
        name: "get_attachment",
        arguments: {
          inbox_id: account.inbox_id,
          message_id: ingested.messageId,
          attachment_id: rows.results[0]?.attachment_id,
        },
      },
    }),
  });
  const body = await response.text();
  const frame = body.split("\n").find((line) => line.startsWith("data: "));
  const message = JSON.parse((frame ?? "").slice("data: ".length)) as {
    result: { content: { text: string }[] };
  };
  const attachment = JSON.parse(message.result.content[0]?.text ?? "{}") as {
    text?: string;
    text_status: string;
  };

  expect(attachment.text_status).toBe("extracted");
  expect(attachment.text).toContain("Tool body");
});

it("leaves outbound attachments unextracted", async () => {
  await markAccountVerified(env.DB, ACCOUNT_ID, 2);

  const sent = await sendMessage(fakeEmail(), principalFor(true), INBOX_ID, {
    to: OWNER_EMAIL,
    subject: "Outbound document",
    text: "Attached.",
    attachments: [
      {
        filename: "report.pdf",
        content_type: PDF_CONTENT_TYPE,
        content: base64Of(minimalPdf("Outbound body")).replace(/\n/g, ""),
      },
    ],
  });

  expect(sent.attachments).toHaveLength(1);
  expect(sent.attachments[0]?.text_status).toBe("none");
  const row = await env.DB.prepare("SELECT text, text_status FROM attachments WHERE message_id = ?")
    .bind(sent.message_id)
    .first<{ text: string | null; text_status: string }>();
  expect(row?.text).toBeNull();
  expect(row?.text_status).toBe("none");
});
