# Architecture

How intray is put together and why. `docs/api.md` is the wire contract; this file is the design
behind it.

## Components

One Cloudflare Worker holds every surface. `src/index.ts` routes `/mcp` to the MCP handler and
everything else to the Hono app, and exports the `email()` handler that Email Routing calls and the
`scheduled()` handler a one-minute cron trigger calls to drain due drafts.
`queue()` handler that drains webhook deliveries.

```
Email Routing catch-all ──► email() ──► postal-mime ──► D1 (thread and message rows)
                                                     └─► R2 (raw .eml, attachments)
HTTP /v1/*  (Hono)  ─┐
                     ├──► src/core/* ──► src/db/* ──► D1
MCP  /mcp           ─┘                ├─► R2, env.EMAIL.send
                                      └─► env.WEBHOOKS ──► queue() ──► subscriber's endpoint
```

| Layer | Path | Role |
| --- | --- | --- |
| adapters | `src/http/`, `src/mcp/` | parse and validate input, call core, format the result |
| services | `src/core/` | the only place with business logic |
| storage | `src/db/` | typed D1 helpers, one module per table |
| mail | `src/email/` | inbound ingest, threading, MIME parsing, outbound builders |
| helpers | `src/lib/` | ids, otp, hash, errors, pagination, address, limits, rfc, time |
| setup | `scripts/` | the operator command that provisions a deployment |
| cron | `triggers.crons` in `wrangler.jsonc` | `* * * * *`, calling `scheduled()` and so `drainDueDrafts` |

Bindings: `DB` (D1), `BUCKET` (R2), `EMAIL` (`send_email`, remote), `RATE` (rate limit),
`WEBHOOKS` (a producer on the `intray-webhooks` queue, consumed by this same Worker), and the
vars `MAIL_DOMAINS`, `INBOX_LIMIT`, `PUBLIC_URL`, `ALLOWED_SIGNUP_EMAILS`,
`QUOTA_MESSAGES_SENT_PER_MONTH`, `QUOTA_MESSAGES_RECEIVED_PER_MONTH` and `QUOTA_STORAGE_BYTES` plus
the `OPERATOR_TOKEN` secret. `src/env.ts` turns those into a `Config`.

## Inbound

`handleEmail(message, env, ctx)` reads `message.raw` into a `Uint8Array` sized by `message.rawSize`
and calls `ingestInbound(env, {envelopeFrom, envelopeTo, raw})`, which runs:

1. reject when `raw.byteLength` exceeds `INBOUND_MAX_BYTES` (`552 message too large`);
2. `splitTag(envelopeTo)` then `getInbox` on the base address, rejecting an unknown recipient
   (`550 no such inbox`); the `+tag` is stripped for the lookup, so tagged addresses land in the
   base inbox, and it is kept for step 7;
3. `withinInboundQuota` on the owning account, rejecting a message past the received or storage
   quota (`552 quota exceeded`) before anything is written;
4. `parseMime(raw)` through `postal-mime`, yielding a `ParsedEmail` with bare RFC identifiers and a
   `preview` derived from the text body, or from tag-stripped html when there is none;
5. `BUCKET.put("raw/{message_id}.eml")` and `BUCKET.put("att/{message_id}/{n}")` per attachment;
6. `resolveThreadId` matching `[inReplyTo, ...references]` against `messages.rfc_message_id` in the
   same inbox, else a new `thr_` row whose subject and participants come from this message;
7. `insertMessage` with `direction: "inbound"`, labels `["received","unread"]` plus the recipient's
   tag when it can be a label, `size`, `has_attachments` and `raw_key`, then one `insertAttachment`
   per stored object;
8. `touchThread`, which bumps `last_message_at`, rewrites `participants_json`, fills a missing
   subject, and increments `message_count`.

Rejections are thrown as `InboundRejected` and turned into `message.setReject(reason)` by
`handleEmail`. Anything else propagates, so Cloudflare retries or bounces.

Threading has no subject-based fallback: a reply from a client that drops both `In-Reply-To` and
`References` starts a new thread.

### Attachment text

Step 8 is followed by `storeAttachmentText` in `src/core/attachments.ts`, which runs
`extractText(contentType, filename, bytes)` from `src/email/extract.ts` over the bytes already in
memory and writes the result onto the row with `updateAttachmentText`. PDF goes through `unpdf`,
pdf.js packaged for serverless runtimes; docx is unzipped with `fflate` and the text runs are pulled
out of `word/document.xml` with paragraphs joined by newlines, so no docx library is bundled. An
input over 10 MiB is skipped as `too_large` and the output is capped at 256 KiB of UTF-8, truncated
on a character boundary; whitespace runs are collapsed and paragraph breaks are kept. Nothing thrown
escapes: a file that cannot be parsed is recorded as `failed` and ingest still succeeds. Outbound
attachments are not extracted and stay `none`.

Extraction is the last step of ingest, after `touchThread`, so that a heavy document that exhausts
the handler's CPU budget cannot leave a message row behind a thread that was never touched.

pdf.js detaches the buffer it is handed, so `extractPdf` passes it a copy and the caller's bytes
stay usable. `unpdf` is loaded with a dynamic `import` inside `extractPdf` rather than at module
scope, so the roughly 2.4 MB pdf.js bundle is parsed only on the first PDF and stays off the
Worker's cold-start path; `fflate` is small enough to stay a static import.

## Outbound

`sendMessage`, `replyToMessage` and `forwardMessage` in `src/core/messages.ts` run the same six
steps:

1. `requireInbox`, which scopes the inbox to the calling principal's account;
2. `assertSendQuota`, which throws `429 quota_exceeded` when the account has already sent
   `QUOTA_MESSAGES_SENT_PER_MONTH` this UTC month, before anything is composed;
3. build through `src/email/outbound.ts`, which normalizes and dedupes recipients, enforces
   `OUTBOUND_MAX_RECIPIENTS`, `OUTBOUND_MAX_ATTACHMENTS` and `OUTBOUND_MAX_BYTES`, and returns both
   an `EmailMessageBuilder` and the derived fields the row needs;
4. reject an unverified account sending anywhere but its own `accounts.email` with
   `403 message_rejected`;
5. `send`, which maps the binding's `E_*` codes onto `AppError`s and normalizes the returned
   `messageId`;
6. persist one `direction: "outbound"` row labelled `["sent"]` with `raw_key` null, store each
   attachment at `att/{message_id}/{n}`, and call `touchThread`.

All three take an optional `from`. `resolveSender` accepts it only when it normalizes to the
inbox's own address, so an inbox can send as itself or as a subaddress of itself and nothing else;
anything else is `400 invalid_address`. A tag on it makes the From header, the stored `from_addr`
and the `["sent", tag]` labels all carry it, which is what makes the recipient reply to the
subaddressed address and the inbound path label the reply the same way.

A reply stays in the parent's thread and carries `In-Reply-To` and `References` built from the
parent's stored bare identifiers, bracketed on the wire. A send or a forward opens a new thread.
`reply_all` puts every merged recipient in `To` and never in `Cc`, and a forward re-sends the
parent's inline attachments as ordinary attachments.

### Drafts

A draft is the same outbound body held in `drafts.body_json` until an agent or the cron sends it.
Attachment bytes are not: they go to R2 at `drf/{draft_id}/{n}`, `n` being the index in the draft's
attachment list, and `body_json` keeps `{filename, content_type, size, key}` per attachment, so a
draft row stays small and D1 holds no bytes. A create, and an update that carries `attachments`,
decodes and validates the base64 first, writes the objects, then writes the row; an update that
replaces them deletes the objects left behind. A send reads them back, and drops them once the sent
message holds its own copies under `att/`; a failed send keeps them so the draft can be fixed and
re-sent. Deleting the draft or its inbox deletes them.
`src/core/drafts.ts` validates every write by building the message through `buildSend` or
`buildReply` and throwing the build away, so create and update reject exactly what the send would
reject and a stored draft is always sendable at the time it was written. `resolveSender` is shared
with `src/core/messages.ts` for the same reason.

`sendDraft` and `drainDueDrafts` both call `sendMessage` or `replyToMessage` rather than `send`, so
the verification gate, the limits, labels, threading and the outbound row are identical to a
synchronous send and a draft is not a second outbound path. The drain builds its `Principal` from
the inbox's account row with `keyId` `cron`.

`drainDueDrafts` selects `scheduled` drafts with `send_at <= now`, oldest first, at most 50 a run,
and claims each with `UPDATE drafts SET status = 'sending' WHERE draft_id = ? AND status =
'scheduled'`, proceeding only when that changed a row. Two overlapping runs therefore send a draft
once. Each draft ends `sent` with its `sent_message_id` or `failed` with the `AppError` code and
message in `error`; a failed draft is never retried on its own and is re-scheduled by an update. A
draft left `sending` by a Worker killed mid-send is picked up by nothing, which is the deliberate
trade: at most one send, and a stuck row an operator can see, rather than a duplicate email.

`src/email/system.ts` holds `sendOtpEmail`, the only mail the service sends on its own behalf.

## Webhooks

An account registers https endpoints that receive `message.received` and `message.sent`.
`src/core/webhooks.ts` holds the whole feature and splits into three parts.

**Emit.** `emitEvent(env, accountId, event, inboxId, messageId)` loads the account's active
webhooks that name the event and enqueues one `{webhook_id, event, delivery_id, inbox_id,
message_id}` job per webhook onto `env.WEBHOOKS`, in a single `sendBatch` when there is more than
one. The job carries ids and not the message itself: a queue message body is capped at 128 KB, and
a mail with a large body or an inline image would exceed it and lose the event. `ingestInbound`
calls it once the message row, its attachments and the thread are written, resolving the account
through the inbox row; `persistOutbound` calls it for `message.sent`. It never throws: a queue that
will not take the job is logged and the ingest or the send finishes normally, because a
subscriber's plumbing must not bounce mail or fail an agent's send.

**Queue.** The producer binding and the consumer are the same `intray-webhooks` queue, with
`max_retries` 5, `max_batch_size` 10 and `max_batch_timeout` 5. It sets no `retry_delay`, because
`deliverBatch` gives each failed message its own delay. The `queue` export in `src/index.ts` hands
the batch to `deliverBatch`.

**Deliver.** `deliverJob` reloads the webhook and drops the job when it is gone or deactivated,
then reads the message row and its attachments and serializes them with `toMessage`, dropping the
job when the message has been deleted, since there is nothing left to report. So the payload is the
message as it stands at delivery time, not as it was when the event fired. It builds `{event,
delivery_id, created_at, data}`, signs `<unix seconds>.<body>` with HMAC-SHA256 over the stored
secret, and POSTs with `x-intray-event`, `x-intray-delivery`, `x-intray-timestamp` and
`x-intray-signature: v1=<hex>` under a 10 second `AbortSignal.timeout`. A 2xx acks and the response
body is cancelled to release the connection; anything else throws and `deliverBatch` calls
`message.retry({delaySeconds})` on that message alone, so one broken endpoint in a batch does not
replay the others. `retryDelaySeconds(attempts)` is `60 * 2 ** (attempts - 1)` capped at an hour,
which spreads the five retries over 1, 2, 4, 8 and 16 minutes.

**Why Queues.** The alternative, delivering inline from the inbound handler, puts a stranger's
endpoint on the path of every inbound message: a consumer that takes 30 seconds to answer would
hold the SMTP transaction open, and a consumer that is down would need retry state invented in D1.
A queue already has the durability, the batching and the backoff, and `waitUntil` has neither
retries nor a delay.

The secret is stored as written rather than hashed, unlike an API key, because HMAC needs the
original bytes. It is returned only by the create call, so a subscriber that loses it registers
another webhook.

## Usage

`src/core/usage.ts` keeps per-account counters and enforces the quotas over them; `src/db/usage.ts`
holds the SQL. Everything lands in one `usage` table keyed `(account_id, period)`, where `period` is
either a `YYYY-MM` UTC month, carrying `messages_sent` and `messages_received`, or the literal `all`,
carrying the running `storage_bytes`. One table holds both the monthly and the lifetime figures, so a
new month costs no schema and no migration. Inboxes held is not stored: `countInboxes` reads it live,
because it is already a cheap indexed count and a stored copy could drift.

Every counter is a single `INSERT ... ON CONFLICT DO UPDATE` that adds to the column, never a read
followed by a write, so two ingests landing in the same millisecond both count. `storage_bytes` is
clamped with `MAX(0, ...)` on both the insert and the update path, because a deployment that adopts
the counters mid-life deletes objects it never counted and would otherwise go negative.

`recordReceived` is called by `ingestInbound` once the message, its attachments and the thread are
written; `recordSent` by `persistOutbound`, which covers a send, a reply, a forward and a draft send
alike, since drafts go through the same functions. `recordStorageDelta` runs negative on every delete
path: message delete, batch delete, thread delete and inbox delete, each summing the rows it is about
to remove before it removes them. The bytes counted per message are the size on the message row plus
the size of each stored attachment. Draft attachment bytes under `drf/` are deliberately not counted:
a draft is a work in progress, its bytes move under `att/` when it sends, and counting both would
charge for the same attachment twice.

Like `emitEvent`, none of the counters can fail the operation they accompany: each swallows and logs
its error, because an accounting write must never bounce mail or fail an agent's send.

The quotas are `QUOTA_MESSAGES_SENT_PER_MONTH`, `QUOTA_MESSAGES_RECEIVED_PER_MONTH` and
`QUOTA_STORAGE_BYTES`, all unlimited when empty, absent or `0`. `assertSendQuota` runs in
`sendMessage`, `replyToMessage` and `forwardMessage` right after `requireInbox` and before the
message is built, so nothing is composed or sent for a request that cannot land; it throws 429
`quota_exceeded`. `withinInboundQuota` runs in `ingestInbound` right after the recipient resolves and
before the first R2 put, so a rejected message leaves no rows and no objects; the handler turns it
into `552 quota exceeded`. Inbox creation keeps its own `INBOX_LIMIT` check and its `conflict` error.
The operator principal is exempt from all three, on the same reasoning as the rest of the operator
token: a personal deployment should not be able to lock itself out. Its usage is still counted.

Counters are per account. An org rollup, once orgs exist, is a `GROUP BY` over the member accounts'
rows for a period, which is why `period` carries its own index and why nothing here is keyed on an
org.

## Auth and onboarding

`signup(env, {email, username?}, {ip?})` validates and lowercases the email, refuses a blocked
signup domain and an address outside `ALLOWED_SIGNUP_EMAILS` when that var is set, calls
`RATE.limit({key: ip})` when the adapter passed an ip, then either reuses the account with that
email or inserts one. A new account gets an inbox from `createInbox` and an active key. An existing
account keeps its inboxes and its live keys and gets a **pending** key
(`api_keys.activated_at IS NULL`). Either way an unverified account gets a fresh OTP (`insertOtp`,
hash only; older codes stay until `verify` succeeds so the per-hour cap can count them) and
`sendOtpEmail`; a send failure is reported as `otp_sent: false` rather than failing the call.

`verify` accepts an active or a pending key. With the correct code it activates a pending key,
revokes every other key on the account, and marks the account verified.

`authenticate(env, rawKey)` checks the `OPERATOR_TOKEN` first, then hashes the presented key and
looks it up by hash among the unrevoked, activated rows, loads the account, and returns a
`Principal` (`{account, keyId, pending}`). It never throws. Every service function takes that
`Principal` and scopes its queries to `principal.account.id`.

## MCP

`handleMcp` reads the key from `Authorization: Bearer` or `X-API-Key` and runs `authenticate`
before it builds a fresh `McpServer` for the request through `createMcpHandler`. Which tool set is
registered depends on the result: three onboarding tools without a live key, thirty-four with one.
Server instructions differ by auth state, and an operator connection gets a note saying no signup
is needed. Tools call the same `src/core` functions the HTTP routes call and return JSON in a
single text block.

## Data model

One D1 database. `0001_init.sql` is the released baseline and every later change is its own
numbered migration.

| Table | Key | Notes |
| --- | --- | --- |
| `accounts` | `id` (`acc_`) | unique `email`, `verified_at` null until the OTP is exchanged |
| `api_keys` | `id` (`key_`) | unique `key_hash`, `scopes_json` (`["*"]` in v1), `activated_at`, `revoked_at` |
| `otps` | `account_id` | `code_hash`, `expires_at`, `attempts`; codes are never stored in the clear |
| `inboxes` | `inbox_id` (the address) | `username` and `domain` denormalized, `display_name` |
| `threads` | `thread_id` (`thr_`) | `subject`, `last_message_at`, `message_count`, `participants_json` |
| `messages` | `message_id` (`msg_`) | `direction`, RFC identifiers, address columns, bodies, `labels_json`, `raw_key` |
| `attachments` | `attachment_id` (`att_`) | `r2_key`, `filename`, `content_type`, `size`, `inline`, `content_id`, `text`, `text_status` |
| `drafts` | `draft_id` (`drf_`) | `kind`, `parent_message_id`, `body_json` (attachment metadata only, bytes in R2), `send_at`, `status`, `sent_message_id`, `error`; indexed on `(inbox_id, updated_at)` and `(status, send_at)` |
| `usage` | `(account_id, period)` | `period` is a `YYYY-MM` UTC month or the literal `all`; `messages_sent`, `messages_received`, `storage_bytes` |
| `webhooks` | `webhook_id` (`whk_`) | `account_id`, `url`, `secret`, `events_json`, `description`, `active` |
| `messages_fts` | `message_id` (UNINDEXED) | FTS5 index over `subject`, `text`, `from_addr`, `from_name`; `inbox_id` UNINDEXED |

Everything hangs off `account_id` through its inbox, and every child row cascades on delete.

`messages_fts` is a standalone FTS5 table, not an external-content one: `messages` has a TEXT
primary key, so its implicit integer rowid is not a stable `content_rowid` and an external-content
index could silently drift. It carries its own copy of the indexed text and is kept in sync by
`AFTER INSERT`, `AFTER DELETE` and `AFTER UPDATE OF subject, text, from_addr, from_name` triggers
on `messages`, all keyed on `message_id`. The tokenizer is `unicode61 remove_diacritics 2`: it
folds case and diacritics across Unicode and splits on every non-alphanumeric character, which
turns an address into `alice`, `example`, `com` and makes a sender searchable by any part of it.

R2 holds raw MIME at `raw/{message_id}.eml`, attachment bytes at `att/{message_id}/{n}`, where `n`
is the attachment's index in the parsed message, and unsent draft attachment bytes at
`drf/{draft_id}/{n}`. An outbound message has no raw object and uses the same attachment layout, so
downloading an attachment works for sent mail too. Deleting an inbox, thread or message through
`src/db` returns the `rawKeys` and `attachmentKeys` it removed, and an inbox delete also returns
the `draftKeys` of its drafts, so the caller can drop the matching objects; the db layer never
touches R2.

## Conventions

**D1 for metadata, R2 for bytes; no Durable Object per inbox.** Cross-inbox queries, filters and
pagination stay plain SQL and rows stay small, at the cost of `wait_for_message` polling D1 instead
of being woken by an actor.

**`inboxes.inbox_id` is the full lowercase address and is the primary key.** Inbound mail arrives
with a recipient address and nothing else, so the hot path is a lookup by primary key; API paths
are self-describing and an address is URL-encoded in a path.

**RFC message identifiers are stored bare: no angle brackets, no surrounding whitespace, case
preserved.** Threading compares stored identifiers with plain equality, so one canonical form has
to be fixed for both sides; `src/lib/rfc.ts` is the only converter, and anything writing a header
back onto the wire adds the brackets itself. Case is preserved because the left-hand side of an
identifier is opaque and generators do produce case-sensitive tokens. A message with no
`Message-ID` stores `NULL` and can never be threaded onto, which is correct.

**Ids are lowercase monotonic ULIDs with a type prefix** (`acc_`, `key_`, `thr_`, `msg_`, `att_`,
`drf_`).
Lists order by `created_at DESC` and break ties on the id, so ids minted in the same millisecond
must still sort in creation order.

**Labels are a plain string array on the message.** Inbound is `["received","unread"]`, outbound is
`["sent"]`, and a filter matches messages carrying all of the requested labels; a set of strings
needs no schema change when a new label appears. A subaddress tag is appended to that default set,
so an address is a second way to write the same column and a human handing out
`desk-agent+support@` gets a filtered channel without the agent labelling anything. A tag that
`normalizeLabels` would refuse is dropped rather than rejected: an address a stranger controls must
never be able to bounce mail or write an oversized row.

**Lists are keyset-paginated.** A query fetches `limit + 1` rows and hands them to `page(rows,
limit, toCursor)` from `src/lib/pagination.ts`, which trims and emits an opaque `next_page_token`
encoding the last row's sort key, so a page is stable while new mail arrives at the head. Message
search is the one exception: it orders by relevance, which is not a key, so its token encodes an
offset into the result set instead.

**HTTP routes and MCP tools are thin adapters over `src/core`.** The same operations are exposed
twice, so implementing them per adapter would let validation, error codes and semantics drift. Core
throws `AppError`; HTTP maps it to `{error:{code,message}}` with a status and MCP maps it to a tool
error. No file under `src/http` or `src/mcp` touches a D1, R2 or EMAIL binding for anything but
passing `env` through.

**A request that writes more than one row does it in one `db.batch([...])`.** D1 runs a batch as a
single transaction, so a batch label change, a batch delete, and a thread or message delete with its
attachments either land whole or not at all. The reads that decide what to write, including the
`IN` list that checks every id belongs to the inbox, run first and outside the batch; a request
whose check fails throws before a single statement is queued.

**`*_json` columns are parsed in `src/core/serialize.ts` and nowhere else**, and every `src/db`
function takes `db: D1Database` first, binds every parameter, and returns rows whose fields are the
literal column names.

**Onboarding is an emailed OTP, and there is no dashboard.** An agent gets a working key and an
inbox from one unauthenticated `POST /v1/agent/signup`, and only outbound reach is gated: until the
account exchanges the six-digit code it may email its own signup address alone. Proving control of
the address is what unlocks sending, so a fabricated address gains nothing. The guards are a
10-minute OTP expiry, 5 attempts, at most 3 codes per hour per address, per-IP rate limiting on
signup, a reserved-username list, and `INBOX_LIMIT` per account.

**A repeat signup mints a pending key rather than revoking anything.** A pending key authenticates
nowhere except `verify`, so an attacker who knows the address cannot take an account over, and the
owner who lost a key can still get back in by reading the emailed code.

**`ALLOWED_SIGNUP_EMAILS` closes signup to a list.** A single-tenant deployment should not be an
open relay for anyone who can reach the endpoint; empty leaves signup open.

**The `OPERATOR_TOKEN` secret authenticates a fixed operator principal.** A personal deployment
should need no signup at all: the token resolves to `acc_operator`, verified from creation, and is
checked ahead of the key-hash lookup. It is not an `api_keys` row, so it cannot be listed or
revoked through the API, and its address `operator@MAIL_DOMAINS[0]` is reserved against signup.
A value absent, empty, or shorter than 32 characters disables it.

**A long poll and a webhook are both first-class, and neither replaces the other.** A webhook
consumer has to run a reachable HTTPS endpoint and verify signatures, which does not match how most
MCP clients are deployed, so `wait` stays the primitive that fits a tool call: it holds a request
for up to 55 seconds, polls D1 every 2 seconds, and returns the first matching message or an empty
result. A webhook is for the deployment that does have somewhere to receive a push, and it costs
the reading path nothing.
