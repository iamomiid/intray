# Roadmap

Ordered. Each item is additive; v1 data model already reserves the columns the early items need.

## 1. Company mode

Turn a single-person deployment into a multi-seat one without rewriting v1.

Add `orgs(id, name, created_at)` and `memberships(org_id, account_id, role)` where `role` is
`admin` or `member`. Every existing row already hangs off `account_id`, so orgs slot in above
accounts and inboxes join to an org through the owning account.

An admin bootstraps the instance by presenting `ADMIN_SECRET` (a Worker secret) once, which creates
the first org and makes the calling account its admin. Admins invite members by email; the invite
is delivered as an OTP over the same flow as signup, and accepting it creates the account and its
membership. Admins provision inboxes directly to members; members create further inboxes under
their own quota.

API keys gain per-inbox scopes. `api_keys.scopes_json` already exists and holds `["*"]` in v1, so
scoping is a value change plus an enforcement check, not a migration of shape. Add an append-only
`audit_log(id, org_id, account_id, action, target, created_at)` covering invites, provisioning, key
creation and revocation, and inbox deletion. Per-org sending domains follow item 7.

Once any org exists, `POST /v1/agent/signup` becomes invite-only and returns 403 for uninvited
addresses; a deployment with no org keeps open signup, so v1 behavior is the zero-org case.

## 2. Subaddressing and automatic labels

Manual labels already exist (`update_message_labels`, `messages.labels_json`). Add the automatic
side: capture the `+tag` on an inbound recipient address and apply it as a label on ingest.
`normalizeAddress` (`src/lib/address.ts`) already strips `+tag` to resolve the inbox; keep that
resolution and additionally record the tag, so mail to `desk-agent+invoices@agents.example.com`
still lands in the `desk-agent` inbox but arrives pre-labeled `invoices`. Extend `send_message` and
`reply_to_message` to accept a subaddressed `from` so an agent can label its own outbound mail the
same way. Manual labeling stays exactly as it is; subaddressing is a second, address-driven way to
reach the same `labels_json` column, so a human can hand an agent `desk-agent+support@...` as a
ready-filtered channel without the agent calling `update_message_labels` after the fact.

## 3. Webhooks

Per-account endpoints receiving `message.received` and `message.sent`. HMAC-SHA256 signature over
the body with a per-endpoint secret. Delivery and retry through Cloudflare Queues so a slow consumer
never blocks the inbound handler.

## 4. Drafts and scheduled send

A `drafts` table plus `send_at` on outbound rows. A cron trigger drains due drafts through the same
`src/email/outbound.ts` path the synchronous send uses.

## 5. Thread update/delete, message batch operations

Bulk label and delete over a list of message ids, and thread-level archive/delete that cascades to
its messages. Batched D1 statements, one transaction per request.

## 6. Full-text search

D1 FTS5 virtual table over `subject`, `text`, and sender, kept in sync by triggers. Replaces the
`LIKE`-based `search_messages` with ranked results while keeping the same response shape.

## 7. Custom domains per account

Register an account-owned domain through the Cloudflare API: add the Email Routing catch-all rule
and run sending-domain onboarding. Adds `domains(domain, account_id, verified_at)` and drops the
reliance on a single operator-wide `MAIL_DOMAINS`.

## 8. Attachment text extraction

Extract text from PDF and docx attachments on ingest and expose it on `get_attachment` so an agent
can read a document without downloading and parsing bytes itself.

## 9. Suppression list and bounce handling

Parse the bounce traffic arriving on the `cf-bounce` MX and maintain a per-account suppression list.
Sends to a suppressed address fail fast with a clear error instead of burning quota.

## 10. Per-inbox Durable Object

Replace `wait_for_message`'s D1 polling with a push-style wait backed by a Durable Object per inbox.
Lower latency and no polling cost; the D1 path stays as the fallback.

## 11. Client SDKs

Publish `GET /openapi.json` and generate TypeScript and Python clients from it, so an agent can use
a typed client instead of raw HTTP.

## 12. OAuth for MCP clients

Authorization-code flow for MCP clients that cannot set static headers, issuing tokens that map to
the same API-key records.

## 13. Spam scoring and virus scanning on inbound

Score inbound mail and label or reject accordingly, so an agent is not handed obvious junk.

## 14. Usage metrics and quotas

Per-account and per-org counters for messages sent and received, storage used, and inboxes held,
with enforceable quotas.

## 15. Deliverability visibility as MCP tools

Expose what an agent currently cannot see about its own sending: the DMARC aggregate reports for
the mail domain, a reputation summary derived from them and from bounce traffic, and the
suppression list from item 9. Read-only tools alongside the existing ones, so an agent can find out
that its mail is being rejected without an operator reading a dashboard for it.
