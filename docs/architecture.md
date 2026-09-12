# Architecture

How intray is put together and why. `docs/api.md` is the wire contract; this file is the design
behind it.

## Components

One Cloudflare Worker holds every surface. `src/index.ts` routes `/mcp` to the MCP handler and
everything else to the Hono app, and exports the `email()` handler that Email Routing calls.

```
Email Routing catch-all ──► email() ──► postal-mime ──► D1 (thread and message rows)
                                                     └─► R2 (raw .eml, attachments)
HTTP /v1/*  (Hono)  ─┐
                     ├──► src/core/* ──► src/db/* ──► D1
MCP  /mcp           ─┘                └─► R2, env.EMAIL.send
```

| Layer | Path | Role |
| --- | --- | --- |
| adapters | `src/http/`, `src/mcp/` | parse and validate input, call core, format the result |
| services | `src/core/` | the only place with business logic |
| storage | `src/db/` | typed D1 helpers, one module per table |
| mail | `src/email/` | inbound ingest, threading, MIME parsing, outbound builders |
| helpers | `src/lib/` | ids, otp, hash, errors, pagination, address, limits, rfc, time |
| setup | `scripts/` | the operator command that provisions a deployment |

Bindings: `DB` (D1), `BUCKET` (R2), `EMAIL` (`send_email`, remote), `RATE` (rate limit), and the
vars `MAIL_DOMAINS`, `INBOX_LIMIT`, `PUBLIC_URL`, `ALLOWED_SIGNUP_EMAILS` plus the `OPERATOR_TOKEN`
secret. `src/env.ts` turns those into a `Config`.

## Inbound

`handleEmail(message, env, ctx)` reads `message.raw` into a `Uint8Array` sized by `message.rawSize`
and calls `ingestInbound(env, {envelopeFrom, envelopeTo, raw})`, which runs:

1. reject when `raw.byteLength` exceeds `INBOUND_MAX_BYTES` (`552 message too large`);
2. `splitTag(envelopeTo)` then `getInbox` on the base address, rejecting an unknown recipient
   (`550 no such inbox`); the `+tag` is stripped for the lookup, so tagged addresses land in the
   base inbox, and it is kept for step 6;
3. `parseMime(raw)` through `postal-mime`, yielding a `ParsedEmail` with bare RFC identifiers and a
   `preview` derived from the text body, or from tag-stripped html when there is none;
4. `BUCKET.put("raw/{message_id}.eml")` and `BUCKET.put("att/{message_id}/{n}")` per attachment;
5. `resolveThreadId` matching `[inReplyTo, ...references]` against `messages.rfc_message_id` in the
   same inbox, else a new `thr_` row whose subject and participants come from this message;
6. `insertMessage` with `direction: "inbound"`, labels `["received","unread"]` plus the recipient's
   tag when it can be a label, `size`, `has_attachments` and `raw_key`, then one `insertAttachment`
   per stored object;
7. `touchThread`, which bumps `last_message_at`, rewrites `participants_json`, fills a missing
   subject, and increments `message_count`.

Rejections are thrown as `InboundRejected` and turned into `message.setReject(reason)` by
`handleEmail`. Anything else propagates, so Cloudflare retries or bounces.

Threading has no subject-based fallback: a reply from a client that drops both `In-Reply-To` and
`References` starts a new thread.

## Outbound

`sendMessage`, `replyToMessage` and `forwardMessage` in `src/core/messages.ts` run the same five
steps:

1. `requireInbox`, which scopes the inbox to the calling principal's account;
2. build through `src/email/outbound.ts`, which normalizes and dedupes recipients, enforces
   `OUTBOUND_MAX_RECIPIENTS`, `OUTBOUND_MAX_ATTACHMENTS` and `OUTBOUND_MAX_BYTES`, and returns both
   an `EmailMessageBuilder` and the derived fields the row needs;
3. reject an unverified account sending anywhere but its own `accounts.email` with
   `403 message_rejected`;
4. `send`, which maps the binding's `E_*` codes onto `AppError`s and normalizes the returned
   `messageId`;
5. persist one `direction: "outbound"` row labelled `["sent"]` with `raw_key` null, store each
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

`src/email/system.ts` holds `sendOtpEmail`, the only mail the service sends on its own behalf.

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
registered depends on the result: three onboarding tools without a live key, eighteen with one.
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
| `attachments` | `attachment_id` (`att_`) | `r2_key`, `filename`, `content_type`, `size`, `inline`, `content_id` |
| `messages_fts` | `message_id` (UNINDEXED) | FTS5 index over `subject`, `text`, `from_addr`, `from_name`; `inbox_id` UNINDEXED |

Everything hangs off `account_id` through its inbox, and every child row cascades on delete.

`messages_fts` is a standalone FTS5 table, not an external-content one: `messages` has a TEXT
primary key, so its implicit integer rowid is not a stable `content_rowid` and an external-content
index could silently drift. It carries its own copy of the indexed text and is kept in sync by
`AFTER INSERT`, `AFTER DELETE` and `AFTER UPDATE OF subject, text, from_addr, from_name` triggers
on `messages`, all keyed on `message_id`. The tokenizer is `unicode61 remove_diacritics 2`: it
folds case and diacritics across Unicode and splits on every non-alphanumeric character, which
turns an address into `alice`, `example`, `com` and makes a sender searchable by any part of it.

R2 holds raw MIME at `raw/{message_id}.eml` and attachment bytes at `att/{message_id}/{n}`, where
`n` is the attachment's index in the parsed message. An outbound message has no raw object and uses
the same attachment layout, so downloading an attachment works for sent mail too. Deleting an
inbox, thread or message through `src/db` returns the `rawKeys` and `attachmentKeys` it removed so
the caller can drop the matching objects; the db layer never touches R2.

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

**Ids are lowercase monotonic ULIDs with a type prefix** (`acc_`, `key_`, `thr_`, `msg_`, `att_`).
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

**No webhooks in v1; the only realtime primitive is a long poll.** A webhook consumer has to run a
reachable HTTPS endpoint and verify signatures, which does not match how MCP clients are deployed,
while a bounded wait fits a tool call exactly. `wait` holds a request for up to 55 seconds, polling
D1 every 2 seconds, and returns the first matching message or an empty result.
