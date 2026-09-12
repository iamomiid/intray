import { env } from "cloudflare:test";
import { beforeEach, expect, it } from "vitest";
import { getAttachment } from "../src/core/attachments";
import { createDraft, getDraft, listDrafts } from "../src/core/drafts";
import { getInbox, listInboxes } from "../src/core/inboxes";
import { createApiKey, listApiKeys } from "../src/core/keys";
import { getMessage, listMessages } from "../src/core/messages";
import {
  createInvite,
  createOrg,
  getOrg,
  listAudit,
  listInvites,
  listMembers,
  listOrgs,
  updateMember,
} from "../src/core/orgs";
import type { Principal } from "../src/core/principal";
import { toAccount, toAttachmentDetail } from "../src/core/serialize";
import { addSuppression, listSuppressions } from "../src/core/suppressions";
import { getThread, listThreads } from "../src/core/threads";
import { getUsage } from "../src/core/usage";
import { createWebhook, getWebhook, listWebhooks } from "../src/core/webhooks";
import { insertAccount } from "../src/db/accounts";
import { listAttachments } from "../src/db/attachments";
import { insertInbox } from "../src/db/inboxes";
import { type InboundResult, ingestInbound } from "../src/email/inbound";
import {
  accountObject,
  apiKeyPage,
  attachmentDetailObject,
  auditPage,
  createdApiKeyObject,
  createdWebhookObject,
  draftObject,
  draftPage,
  inboxObject,
  inboxPage,
  inviteObject,
  invitePage,
  memberObject,
  memberPage,
  messageObject,
  messagePage,
  orgDetailObject,
  orgMembershipPage,
  orgObject,
  suppressionObject,
  suppressionPage,
  threadDetailObject,
  threadPage,
  usageObject,
  webhookObject,
  webhookPage,
} from "../src/schemas/index";
import htmlAttachmentEml from "./fixtures/html-attachment.eml?raw";
import { ADMIN_SECRET, resetDatabase } from "./support";

const ACCOUNT_ID = "acc_schemas";
const INBOX_ID = "agent@intray.example";

function bytes(text: string): Uint8Array {
  return new TextEncoder().encode(text.replace(/\r?\n/g, "\r\n"));
}

function deliver(raw: string): Promise<InboundResult> {
  return ingestInbound(env, {
    envelopeFrom: "alice@example.com",
    envelopeTo: INBOX_ID,
    raw: bytes(raw),
  });
}

async function seed(): Promise<Principal> {
  const account = await insertAccount(env.DB, {
    id: ACCOUNT_ID,
    email: "owner@example.com",
    createdAt: 1,
    verifiedAt: 1,
  });
  await insertInbox(env.DB, {
    inboxId: INBOX_ID,
    accountId: ACCOUNT_ID,
    username: "agent",
    domain: "intray.example",
    displayName: "Agent",
    createdAt: 1,
  });
  return { account, keyId: "key_schemas", pending: false, scopes: ["*"] };
}

beforeEach(async () => {
  await resetDatabase(env.DB);
});

it("parses a serialized account, inbox and api key against their schemas", async () => {
  const principal = await seed();

  expect(accountObject.parse(toAccount(principal.account)).account_id).toBe(ACCOUNT_ID);
  expect(inboxObject.parse(await getInbox(env, principal, INBOX_ID)).inbox_id).toBe(INBOX_ID);
  expect(inboxPage.parse(await listInboxes(env, principal, {})).items).toHaveLength(1);

  const created = await createApiKey(env, principal, { name: "second" });
  expect(createdApiKeyObject.parse(created).key).toBe(created.key);
  expect(apiKeyPage.parse(await listApiKeys(env, principal)).items).toHaveLength(1);
});

it("parses a serialized thread, message and attachment against their schemas", async () => {
  const principal = await seed();
  const delivered = await deliver(htmlAttachmentEml);

  expect(threadPage.parse(await listThreads(env, principal, INBOX_ID, {})).items).toHaveLength(1);
  const thread = threadDetailObject.parse(
    await getThread(env, principal, INBOX_ID, delivered.threadId),
  );
  expect(thread.messages).toHaveLength(1);

  expect(messagePage.parse(await listMessages(env, principal, INBOX_ID, {})).items).toHaveLength(1);
  const message = messageObject.parse(
    await getMessage(env, principal, INBOX_ID, delivered.messageId),
  );
  expect(message.attachments.length).toBeGreaterThan(0);
  expect(message.spam_score).toBe(6);
  expect(message.spam_reasons).toEqual(["html_only"]);

  const rows = await listAttachments(env.DB, delivered.messageId);
  expect(rows.length).toBeGreaterThan(0);
  for (const row of rows) {
    expect(attachmentDetailObject.parse(toAttachmentDetail(row)).message_id).toBe(
      delivered.messageId,
    );
  }

  const first = message.attachments[0];
  if (first === undefined) {
    throw new Error("the fixture carried no attachment");
  }
  const download = await getAttachment(
    env,
    principal,
    INBOX_ID,
    message.message_id,
    first.attachment_id,
  );
  await download.body.cancel();
  expect(attachmentDetailObject.parse(download.attachment).attachment_id).toBe(first.attachment_id);
});

it("parses a serialized draft against its schema", async () => {
  const principal = await seed();
  const draft = await createDraft(env, principal, INBOX_ID, {
    to: "bob@example.com",
    subject: "hello",
    text: "hi",
    attachments: [{ filename: "a.txt", content_type: "text/plain", content: btoa("hi") }],
  });

  expect(draftObject.parse(draft).status).toBe("draft");
  expect(
    draftObject.parse(await getDraft(env, principal, INBOX_ID, draft.draft_id)).attachments,
  ).toHaveLength(1);
  expect(draftPage.parse(await listDrafts(env, principal, INBOX_ID, {})).items).toHaveLength(1);
});

it("parses a serialized webhook against its schema", async () => {
  const principal = await seed();
  const created = await createWebhook(env, principal, { url: "https://hooks.example.com/intray" });

  expect(createdWebhookObject.parse(created).secret).toBe(created.secret);
  expect(webhookObject.parse(await getWebhook(env, principal, created.webhook_id)).active).toBe(
    true,
  );
  expect(webhookPage.parse(await listWebhooks(env, principal)).items).toHaveLength(1);
});

it("parses a serialized suppression against its schema", async () => {
  const principal = await seed();
  const added = suppressionObject.parse(
    await addSuppression(env, principal, {
      address: "blocked@example.com",
      detail: "asked to stop",
    }),
  );

  expect(added.reason).toBe("manual");
  expect(added.message_id).toBeNull();
  expect(suppressionPage.parse(await listSuppressions(env, principal, {})).items).toHaveLength(1);
});

it("parses a serialized org, member, invite and audit entry against their schemas", async () => {
  const principal = await seed();
  const org = await createOrg(env, principal, { name: "Acme", admin_secret: ADMIN_SECRET });

  expect(orgObject.parse(org).name).toBe("Acme");
  expect(orgDetailObject.parse(await getOrg(env, principal, org.org_id)).member_count).toBe(1);
  expect(orgMembershipPage.parse(await listOrgs(env, principal)).items[0]?.role).toBe("admin");

  const invite = await createInvite(env, principal, org.org_id, {
    email: "teammate@agents.example.com",
  });
  expect(inviteObject.parse(invite).accepted_at).toBeNull();
  expect(invitePage.parse(await listInvites(env, principal, org.org_id)).items).toHaveLength(1);

  const member = await updateMember(env, principal, org.org_id, ACCOUNT_ID, { role: "admin" });
  expect(memberObject.parse(member).inbox_count).toBe(1);
  expect(memberPage.parse(await listMembers(env, principal, org.org_id)).items).toHaveLength(1);

  const audit = auditPage.parse(await listAudit(env, principal, org.org_id, {}));
  expect(audit.items.map((entry) => entry.action)).toContain("org.created");
});

it("parses the usage object against its schema", async () => {
  const principal = await seed();
  const usage = usageObject.parse(await getUsage(env, principal));

  expect(usage.inboxes).toBe(1);
  expect(usage.period).toMatch(/^\d{4}-\d{2}$/);
  expect(usage.limits.inboxes).toBe(10);
});

it("rejects an object carrying a field the schema does not name", async () => {
  const principal = await seed();
  const inbox = await getInbox(env, principal, INBOX_ID);

  expect(() => inboxObject.parse({ ...inbox, surprise: true })).toThrow();
});
