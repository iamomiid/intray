import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import skillMd from "../../public/skill.md";
import {
  authenticate,
  batchDeleteMessages,
  batchUpdateLabels,
  createApiKey,
  createDraft,
  createInbox,
  createWebhook,
  deleteDraft,
  deleteInbox,
  deleteMessage,
  deleteThread,
  deleteWebhook,
  forwardMessage,
  getAttachment,
  getDraft,
  getInbox,
  getMessage,
  getThread,
  getWebhook,
  listDrafts,
  listInboxes,
  listMessages,
  listThreads,
  listWebhooks,
  me,
  replyToMessage,
  searchMessages,
  sendDraft,
  sendMessage,
  signup,
  updateDraft,
  updateMessageLabels,
  updateThreadLabels,
  updateWebhook,
  verify,
  waitForMessage,
} from "../core/index";
import type { Principal } from "../core/principal";
import { config, type Env } from "../env";
import { unauthorized } from "../lib/errors";
import { run } from "./result";

const TEXT_BODY_MAX_BYTES = 64 * 1024;

const inboxId = z.string().min(1);

const messageId = z.string().min(1);

const threadId = z.string().min(1);

const webhookId = z.string().min(1);

const labels = z.array(z.string());

const recipients = z.union([z.string(), z.array(z.string())]);

const senderAddress = z.string().optional();

const attachments = z.array(
  z.object({
    filename: z.string(),
    content_type: z.string(),
    content: z.string(),
  }),
);

const pageArgs = {
  limit: z.number().optional(),
  page_token: z.string().optional(),
};

async function attachmentDetail(
  env: Env,
  principal: Principal,
  args: { inbox_id: string; message_id: string; attachment_id: string },
): Promise<Record<string, unknown>> {
  const download = await getAttachment(
    env,
    principal,
    args.inbox_id,
    args.message_id,
    args.attachment_id,
  );
  const { text: extracted, ...attachment } = download.attachment;
  const readable =
    extracted === null &&
    (attachment.content_type ?? "").startsWith("text/") &&
    attachment.size <= TEXT_BODY_MAX_BYTES;
  const decoded = readable ? await new Response(download.body).text() : null;
  if (!readable) {
    await download.body.cancel();
  }
  const text = extracted ?? decoded;
  const base = `${config(env).publicUrl}/v1/inboxes/${encodeURIComponent(args.inbox_id)}`;
  return {
    ...attachment,
    download_url: `${base}/messages/${args.message_id}/attachments/${args.attachment_id}`,
    ...(text === null ? {} : { text }),
  };
}

function registerOnboardingTools(server: McpServer, env: Env): void {
  server.registerTool(
    "signup",
    {
      title: "Sign up",
      description:
        "Create an account for a human's email address. Returns an api_key, an inbox_id, and mails a 6-digit code to that address. For an address that already has an account the returned key is pending (key_pending true) and does nothing until verify succeeds; keys already in use keep working until then.",
      inputSchema: z.object({
        email: z.string(),
        username: z.string().optional(),
      }),
    },
    (args) => run(() => signup(env, { email: args.email, username: args.username }, {})),
  );

  server.registerTool(
    "verify",
    {
      title: "Verify",
      description:
        "Confirm the 6-digit code emailed by signup. Takes the api_key signup returned. A key from a repeat signup stays pending until this succeeds, and activating it revokes every other key on the account. Until the account is verified it can only email its own signup address.",
      inputSchema: z.object({
        api_key: z.string(),
        code: z.string(),
      }),
    },
    (args) =>
      run(async () => {
        const principal = await authenticate(env, args.api_key, { allowPending: true });
        if (principal === null) {
          throw unauthorized("api_key is not a live key");
        }
        return verify(env, principal, { code: args.code });
      }),
  );

  server.registerTool(
    "read_onboarding_docs",
    {
      title: "Read onboarding docs",
      description: "Return the full onboarding and usage instructions as markdown.",
      inputSchema: z.object({}),
    },
    () => run(async () => ({ markdown: skillMd })),
  );
}

function registerAccountTools(server: McpServer, env: Env, principal: Principal): void {
  server.registerTool(
    "auth_me",
    {
      title: "Account",
      description: "Return the account, its inbox count, and the key id this request used.",
      inputSchema: z.object({}),
    },
    () => run(() => me(env, principal)),
  );

  server.registerTool(
    "create_api_key",
    {
      title: "Create API key",
      description: "Mint another API key. The full key is returned only here.",
      inputSchema: z.object({ name: z.string().optional() }),
    },
    (args) => run(() => createApiKey(env, principal, { name: args.name })),
  );
}

function registerInboxTools(server: McpServer, env: Env, principal: Principal): void {
  server.registerTool(
    "list_inboxes",
    {
      title: "List inboxes",
      description: "List this account's inboxes, newest first.",
      inputSchema: z.object(pageArgs),
    },
    (args) => run(() => listInboxes(env, principal, args)),
  );

  server.registerTool(
    "create_inbox",
    {
      title: "Create inbox",
      description:
        "Create an inbox. username defaults to a generated one, domain to the first served domain." +
        " display_name becomes the From name on mail this inbox sends, so set it to a name a human" +
        " recipient would recognize; a bare address alone reads as less trustworthy.",
      inputSchema: z.object({
        username: z.string().optional(),
        domain: z.string().optional(),
        display_name: z.string().optional(),
      }),
    },
    (args) => run(() => createInbox(env, principal, args)),
  );

  server.registerTool(
    "get_inbox",
    {
      title: "Get inbox",
      description: "Fetch one inbox by its full address.",
      inputSchema: z.object({ inbox_id: inboxId }),
    },
    (args) => run(() => getInbox(env, principal, args.inbox_id)),
  );

  server.registerTool(
    "delete_inbox",
    {
      title: "Delete inbox",
      description: "Delete an inbox with every thread, message, and stored object under it.",
      inputSchema: z.object({ inbox_id: inboxId }),
    },
    (args) => run(() => deleteInbox(env, principal, args.inbox_id)),
  );
}

function registerThreadTools(server: McpServer, env: Env, principal: Principal): void {
  server.registerTool(
    "list_threads",
    {
      title: "List threads",
      description: "List an inbox's threads by last_message_at descending.",
      inputSchema: z.object({ inbox_id: inboxId, ...pageArgs }),
    },
    (args) => run(() => listThreads(env, principal, args.inbox_id, args)),
  );

  server.registerTool(
    "get_thread",
    {
      title: "Get thread",
      description: "Fetch one thread with its messages ordered by created_at.",
      inputSchema: z.object({ inbox_id: inboxId, thread_id: threadId }),
    },
    (args) => run(() => getThread(env, principal, args.inbox_id, args.thread_id)),
  );

  server.registerTool(
    "update_thread_labels",
    {
      title: "Update thread labels",
      description:
        'Add and remove labels across every message in a thread. Archive a thread with add ["archived"] and remove ["unread"]. Returns the thread with its messages.',
      inputSchema: z.object({
        inbox_id: inboxId,
        thread_id: threadId,
        add: labels.optional(),
        remove: labels.optional(),
      }),
    },
    (args) => run(() => updateThreadLabels(env, principal, args.inbox_id, args.thread_id, args)),
  );

  server.registerTool(
    "delete_thread",
    {
      title: "Delete thread",
      description: "Delete a thread with every message under it and their stored objects.",
      inputSchema: z.object({ inbox_id: inboxId, thread_id: threadId }),
    },
    (args) => run(() => deleteThread(env, principal, args.inbox_id, args.thread_id)),
  );
}

function registerMessageTools(server: McpServer, env: Env, principal: Principal): void {
  server.registerTool(
    "list_messages",
    {
      title: "List messages",
      description:
        "List an inbox's messages, newest first. labels matches messages carrying all of them; since and before bound created_at in Unix milliseconds.",
      inputSchema: z.object({
        inbox_id: inboxId,
        labels: z.union([z.string(), z.array(z.string())]).optional(),
        from: z.string().optional(),
        to: z.string().optional(),
        subject: z.string().optional(),
        since: z.number().optional(),
        before: z.number().optional(),
        ...pageArgs,
      }),
    },
    (args) => run(() => listMessages(env, principal, args.inbox_id, args)),
  );

  server.registerTool(
    "search_messages",
    {
      title: "Search messages",
      description:
        "Full-text search over an inbox's subjects, bodies and senders. Give plain words: " +
        "every word must match, a word matches by prefix, and results come back by relevance.",
      inputSchema: z.object({ inbox_id: inboxId, q: z.string(), ...pageArgs }),
    },
    (args) => run(() => searchMessages(env, principal, args.inbox_id, args)),
  );

  server.registerTool(
    "get_message",
    {
      title: "Get message",
      description: "Fetch one message with its attachment metadata.",
      inputSchema: z.object({ inbox_id: inboxId, message_id: messageId }),
    },
    (args) => run(() => getMessage(env, principal, args.inbox_id, args.message_id)),
  );

  server.registerTool(
    "wait_for_message",
    {
      title: "Wait for message",
      description:
        "Block until a message with created_at greater than since arrives, or until timeout seconds elapse. since defaults to now, timeout to 30 and caps at 55. Returns an empty items array on timeout.",
      inputSchema: z.object({
        inbox_id: inboxId,
        since: z.number().optional(),
        timeout: z.number().optional(),
      }),
    },
    (args) => run(() => waitForMessage(env, principal, args.inbox_id, args)),
  );

  server.registerTool(
    "update_message_labels",
    {
      title: "Update message labels",
      description: "Replace a message's labels with the given set.",
      inputSchema: z.object({
        inbox_id: inboxId,
        message_id: messageId,
        labels: z.array(z.string()),
      }),
    },
    (args) =>
      run(() =>
        updateMessageLabels(env, principal, args.inbox_id, args.message_id, {
          labels: args.labels,
        }),
      ),
  );

  server.registerTool(
    "delete_message",
    {
      title: "Delete message",
      description: "Delete a message and its stored objects.",
      inputSchema: z.object({ inbox_id: inboxId, message_id: messageId }),
    },
    (args) => run(() => deleteMessage(env, principal, args.inbox_id, args.message_id)),
  );

  server.registerTool(
    "batch_update_labels",
    {
      title: "Batch update labels",
      description:
        "Add and remove labels across up to 100 messages in one call. Returns the updated messages in the order given. Every id must belong to the inbox; one that does not fails the whole call and changes nothing.",
      inputSchema: z.object({
        inbox_id: inboxId,
        message_ids: z.array(messageId),
        add: labels.optional(),
        remove: labels.optional(),
      }),
    },
    (args) => run(() => batchUpdateLabels(env, principal, args.inbox_id, args)),
  );

  server.registerTool(
    "batch_delete_messages",
    {
      title: "Batch delete messages",
      description:
        "Delete up to 100 messages and their stored objects in one call, dropping threads left empty. Every id must belong to the inbox; one that does not fails the whole call and changes nothing.",
      inputSchema: z.object({ inbox_id: inboxId, message_ids: z.array(messageId) }),
    },
    (args) => run(() => batchDeleteMessages(env, principal, args.inbox_id, args)),
  );

  server.registerTool(
    "get_attachment",
    {
      title: "Get attachment",
      description:
        "Return an attachment's metadata, a download_url, plus its text: the text extracted from a PDF or docx on ingest, otherwise the decoded body when the content type is text/* and it is at most 64 KiB. text_status says why text is absent.",
      inputSchema: z.object({
        inbox_id: inboxId,
        message_id: messageId,
        attachment_id: z.string().min(1),
      }),
    },
    (args) => run(() => attachmentDetail(env, principal, args)),
  );
}

const draftId = z.string().min(1);

function registerDraftTools(server: McpServer, env: Env, principal: Principal): void {
  server.registerTool(
    "create_draft",
    {
      title: "Create draft",
      description:
        "Compose a message without sending it. Defaults to kind send; pass parent_message_id to draft" +
        " a reply, which then takes only text, html, from, reply_all and attachments. The body is" +
        " validated exactly as the send would validate it, so an unsendable draft is refused here." +
        " send_at is Unix milliseconds in the future and schedules the draft; a cron trigger sends it" +
        " within a minute of that time.",
      inputSchema: z.object({
        inbox_id: inboxId,
        kind: z.enum(["send", "reply"]).optional(),
        parent_message_id: messageId.optional(),
        from: senderAddress,
        to: recipients.optional(),
        cc: recipients.optional(),
        bcc: recipients.optional(),
        subject: z.string().optional(),
        text: z.string().optional(),
        html: z.string().optional(),
        reply_to: z.string().optional(),
        reply_all: z.boolean().optional(),
        attachments: attachments.optional(),
        send_at: z.number().optional(),
      }),
    },
    (args) => run(() => createDraft(env, principal, args.inbox_id, args)),
  );

  server.registerTool(
    "list_drafts",
    {
      title: "List drafts",
      description:
        "List an inbox's drafts, most recently updated first. status filters by draft, scheduled," +
        " sending, sent or failed.",
      inputSchema: z.object({
        inbox_id: inboxId,
        status: z.enum(["draft", "scheduled", "sending", "sent", "failed"]).optional(),
        ...pageArgs,
      }),
    },
    (args) => run(() => listDrafts(env, principal, args.inbox_id, args)),
  );

  server.registerTool(
    "get_draft",
    {
      title: "Get draft",
      description: "Fetch one draft with its status, schedule and last error.",
      inputSchema: z.object({ inbox_id: inboxId, draft_id: draftId }),
    },
    (args) => run(() => getDraft(env, principal, args.inbox_id, args.draft_id)),
  );

  server.registerTool(
    "update_draft",
    {
      title: "Update draft",
      description:
        "Change any body field of a draft; fields left out keep their value and the result is" +
        " re-validated as a send. send_at reschedules, send_at null unschedules, and a past schedule" +
        " is dropped. A sending or sent draft answers conflict.",
      inputSchema: z.object({
        inbox_id: inboxId,
        draft_id: draftId,
        from: senderAddress,
        to: recipients.optional(),
        cc: recipients.optional(),
        bcc: recipients.optional(),
        subject: z.string().optional(),
        text: z.string().optional(),
        html: z.string().optional(),
        reply_to: z.string().optional(),
        reply_all: z.boolean().optional(),
        attachments: attachments.optional(),
        send_at: z.number().nullable().optional(),
      }),
    },
    (args) => run(() => updateDraft(env, principal, args.inbox_id, args.draft_id, args)),
  );

  server.registerTool(
    "delete_draft",
    {
      title: "Delete draft",
      description: "Delete a draft. A draft being sent right now answers conflict.",
      inputSchema: z.object({ inbox_id: inboxId, draft_id: draftId }),
    },
    (args) => run(() => deleteDraft(env, principal, args.inbox_id, args.draft_id)),
  );

  server.registerTool(
    "send_draft",
    {
      title: "Send draft",
      description:
        "Send a draft now, whatever its send_at, through the same path send_message and" +
        " reply_to_message use. Returns the sent message and marks the draft sent.",
      inputSchema: z.object({ inbox_id: inboxId, draft_id: draftId }),
    },
    (args) => run(() => sendDraft(env, principal, args.inbox_id, args.draft_id)),
  );
}

function registerSendingTools(server: McpServer, env: Env, principal: Principal): void {
  server.registerTool(
    "send_message",
    {
      title: "Send message",
      description:
        "Send a new message from an inbox. to, cc, and bcc take a string or an array; at most 50 recipients and 32 attachments, and the whole message must stay under 5 MiB. from may be the inbox address with a +tag, which labels this message and every reply that comes back to it.",
      inputSchema: z.object({
        inbox_id: inboxId,
        from: senderAddress,
        to: recipients,
        cc: recipients.optional(),
        bcc: recipients.optional(),
        subject: z.string(),
        text: z.string().optional(),
        html: z.string().optional(),
        reply_to: z.string().optional(),
        attachments: attachments.optional(),
      }),
    },
    (args) => run(() => sendMessage(env, principal, args.inbox_id, args)),
  );

  server.registerTool(
    "reply_to_message",
    {
      title: "Reply to message",
      description:
        "Reply in the parent's thread. reply_all merges the parent's from, to, and cc minus the inbox's own address. from may be the inbox address with a +tag, which labels this message and every reply that comes back to it.",
      inputSchema: z.object({
        inbox_id: inboxId,
        message_id: messageId,
        from: senderAddress,
        text: z.string().optional(),
        html: z.string().optional(),
        reply_all: z.boolean().optional(),
        attachments: attachments.optional(),
      }),
    },
    (args) => run(() => replyToMessage(env, principal, args.inbox_id, args.message_id, args)),
  );

  server.registerTool(
    "forward_message",
    {
      title: "Forward message",
      description:
        "Forward a message with its attachments and the original quoted below text. from may be the inbox address with a +tag, which labels this message and every reply that comes back to it.",
      inputSchema: z.object({
        inbox_id: inboxId,
        message_id: messageId,
        from: senderAddress,
        to: recipients,
        cc: recipients.optional(),
        bcc: recipients.optional(),
        text: z.string().optional(),
      }),
    },
    (args) => run(() => forwardMessage(env, principal, args.inbox_id, args.message_id, args)),
  );
}

function registerWebhookTools(server: McpServer, env: Env, principal: Principal): void {
  server.registerTool(
    "create_webhook",
    {
      title: "Create webhook",
      description:
        "Register an https endpoint to receive message.received and message.sent events for this" +
        " account. events defaults to both. The signing secret is returned only here: store it and" +
        " verify the x-intray-signature header on every delivery. At most 10 webhooks per account.",
      inputSchema: z.object({
        url: z.string(),
        events: z.array(z.string()).optional(),
        description: z.string().optional(),
      }),
    },
    (args) => run(() => createWebhook(env, principal, args)),
  );

  server.registerTool(
    "list_webhooks",
    {
      title: "List webhooks",
      description: "List this account's webhooks, newest first. The secret is never returned.",
      inputSchema: z.object({}),
    },
    () => run(() => listWebhooks(env, principal)),
  );

  server.registerTool(
    "get_webhook",
    {
      title: "Get webhook",
      description: "Fetch one webhook by id. The secret is never returned.",
      inputSchema: z.object({ webhook_id: webhookId }),
    },
    (args) => run(() => getWebhook(env, principal, args.webhook_id)),
  );

  server.registerTool(
    "update_webhook",
    {
      title: "Update webhook",
      description:
        "Change a webhook's url, events, description, or active flag. Omitted fields are left" +
        " alone. active false stops delivery without deleting the endpoint or rotating its secret.",
      inputSchema: z.object({
        webhook_id: webhookId,
        url: z.string().optional(),
        events: z.array(z.string()).optional(),
        description: z.string().optional(),
        active: z.boolean().optional(),
      }),
    },
    (args) => run(() => updateWebhook(env, principal, args.webhook_id, args)),
  );

  server.registerTool(
    "delete_webhook",
    {
      title: "Delete webhook",
      description: "Delete a webhook. Queued deliveries for it stop.",
      inputSchema: z.object({ webhook_id: webhookId }),
    },
    (args) => run(() => deleteWebhook(env, principal, args.webhook_id)),
  );
}

export function registerTools(server: McpServer, env: Env, principal: Principal | null): void {
  if (principal === null) {
    registerOnboardingTools(server, env);
    return;
  }
  registerAccountTools(server, env, principal);
  registerInboxTools(server, env, principal);
  registerThreadTools(server, env, principal);
  registerMessageTools(server, env, principal);
  registerSendingTools(server, env, principal);
  registerDraftTools(server, env, principal);
  registerWebhookTools(server, env, principal);
}
