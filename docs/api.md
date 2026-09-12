# API contract

Source of truth for the HTTP and MCP adapters. Both call the same `src/core` functions; anything
below that differs between the two surfaces is a bug.

All JSON field names are snake_case. All timestamps are integer Unix milliseconds.

`GET /openapi.json` is the machine-readable form of this file: an OpenAPI 3.1 document generated
from the same zod schemas in `src/schemas/` that the MCP adapter validates with, so a client can be
generated from it.

## Auth

Every `/v1` endpoint except `POST /v1/agent/signup` requires an API key, sent as either
`Authorization: Bearer it_...` or `X-API-Key: it_...`. Keys are `it_` followed by 32 random bytes
base64url-encoded; only the SHA-256 hash is stored.

MCP requests carry the same header. A request without a valid key gets the unauthenticated tool set,
and a pending key counts as no key there.

A pending key is accepted by `POST /v1/agent/verify` alone; every other endpoint answers 401 until
the code activates it.

### Operator token

A deployment may set the `OPERATOR_TOKEN` secret. It is sent in the same header as an API key and
resolves to the **operator principal**: `key_id` is the literal string `operator` and the account is
`acc_operator`, whose email is `operator@MAIL_DOMAINS[0]`. That account is created on the token's
first use and is verified from the start, so the operator may email anyone and is not subject to
`message_rejected`.

The token is not an api_key row: it never appears in `GET /v1/api-keys` and `DELETE
/v1/api-keys/operator` answers 404. Replace it by putting a new secret. Keys minted with `POST
/v1/api-keys` while holding the token belong to `acc_operator` and are ordinary revocable keys.

The token is not a signup, so `ALLOWED_SIGNUP_EMAILS` does not apply to it. The address
`operator@MAIL_DOMAINS[0]` is reserved: `POST /v1/agent/signup` for it answers 400 `bad_request`
with `email reserved`, whether or not the token is set.

The token is disabled when it is absent, empty, or shorter than 32 characters; a short value is
ignored and logged once per isolate. With it disabled, every request falls through to the ordinary
key lookup.

## Deployment vars

| Var | Meaning |
| --- | --- |
| `MAIL_DOMAINS` | comma-separated mail domains, no spaces. The first is the default for new inboxes |
| `INBOX_LIMIT` | per-account inbox cap, as a string. Default `10` |
| `PUBLIC_URL` | deployed origin, no trailing slash |
| `ALLOWED_SIGNUP_EMAILS` | comma-separated allowlist of signup addresses. Empty or absent leaves signup open; otherwise any other address gets 403 `signup_closed` before any rate limit or write |
| `QUOTA_MESSAGES_SENT_PER_MONTH` | per-account cap on messages sent in a UTC month, as a string. Empty, absent or `0` is unlimited |
| `QUOTA_MESSAGES_RECEIVED_PER_MONTH` | per-account cap on messages received in a UTC month, as a string. Empty, absent or `0` is unlimited |
| `QUOTA_STORAGE_BYTES` | per-account cap on stored bytes, as a string. Empty, absent or `0` is unlimited |
| `OPERATOR_TOKEN` | a **secret**, not a var. Set with `pnpm wrangler secret put OPERATOR_TOKEN` or `pnpm run setup --operator-token`, never in `wrangler.jsonc`. Authenticates the operator principal. Absent, empty, or shorter than 32 characters disables it. Put it in `.dev.vars` for `pnpm dev` |
| `ADMIN_SECRET` | a **secret**, not a var. Set with `pnpm wrangler secret put ADMIN_SECRET`, never in `wrangler.jsonc`. Presented as `x-admin-secret` on `POST /v1/orgs` to bootstrap company mode, and used nowhere else. Absent, empty, or shorter than 32 characters disables the bootstrap. Put it in `.dev.vars` for `pnpm dev` |

Addresses in `ALLOWED_SIGNUP_EMAILS` are compared lowercased and trimmed. `pnpm run setup
--allow-signup you@example.com,teammate@example.com` writes the var.

## Errors

```json
{ "error": { "code": "not_found", "message": "inbox not found" } }
```

| Status | Code |
| --- | --- |
| 400 | `bad_request`, `invalid_address`, `invalid_code`, `e_recipient_suppressed`, `e_too_many_recipients`, `e_content_too_large`, `e_header_not_allowed` |
| 401 | `unauthorized` |
| 403 | `forbidden`, `message_rejected`, `signup_closed` |
| 404 | `not_found` |
| 409 | `conflict`, `inbox_taken` |
| 429 | `too_many_requests`, `quota_exceeded` |
| 500 | `internal_error` |
| 503 | `sender_not_verified` |

`message_rejected` is returned when an unverified account tries to send to any address other than
its own `accounts.email`. `signup_closed` is returned when `ALLOWED_SIGNUP_EMAILS` is set and the
address is not in it, and when an org exists and the address has no open invite. `email reserved`
is returned when a signup names the operator address. `forbidden` is returned when the admin
secret is wrong or disabled, when a member calls an admin-only org endpoint, and when a key scoped
to an inbox calls an account-level endpoint. `quota_exceeded` is returned when a send, reply, forward or draft
send would pass `QUOTA_MESSAGES_SENT_PER_MONTH`; inbound mail past a quota is refused at the SMTP
transaction with `552 quota exceeded` and never becomes an API error.

The four `e_*` codes and `sender_not_verified` come from the send binding and only ever appear on a
send, reply, forward or draft send: they are the binding's `E_RECIPIENT_SUPPRESSED`,
`E_TOO_MANY_RECIPIENTS`, `E_CONTENT_TOO_LARGE`, `E_HEADER_NOT_ALLOWED` and
`E_SENDER_NOT_VERIFIED` lowercased, and `E_RATE_LIMIT_EXCEEDED` becomes `too_many_requests`.

## Status codes

Creates return 201: signup, inbox create, api key create, webhook create, org create, invite
create, org inbox provision, send, reply, forward, draft create, and draft send. Everything else returns 200. Bodies that are entirely optional (`POST
/api-keys`, `POST /inboxes`, `.../reply`) may be omitted and are read as `{}`.

## Pagination

List endpoints return:

```json
{ "items": [], "next_page_token": null }
```

`limit` defaults to 25 and caps at 100. Pass the previous response's `next_page_token` back as
`page_token` to continue. A `null` token means the end of the collection.

## Objects

### account

`account_id`, `email`, `verified`, `created_at`.

### api_key

`key_id`, `prefix`, `name`, `scopes`, `created_at`, `activated_at`, `revoked_at`, `active`. The full
`key` is returned only in the response that creates it. `activated_at` is null while the key is
pending, which only a repeat signup produces; `active` is true when the key is activated and not
revoked. Only an active key authenticates, and the sole exception is `POST /v1/agent/verify`, which
also accepts a pending one.

`scopes` is `["*"]` by default. Any other entry is `inbox:<inbox_id>`, the full lowercase address of
an inbox the account owns. A key holding only `inbox:` scopes reaches every inbox-scoped endpoint on
those inboxes and nothing else: another inbox answers 404 `not_found`, exactly as a missing one
does; `GET /v1/inboxes` returns only the scoped inboxes; and `POST /v1/inboxes`, every
`/v1/api-keys`, `/v1/webhooks` and `/v1/orgs` endpoint answers 403 `forbidden`. `GET /v1/auth/me`
stays open to it. Scope is enforced in `src/core`, so the REST and MCP surfaces behave alike.

### org

`org_id`, `name`, `created_at`. `GET /v1/orgs/:org_id` adds `member_count`; the entries of `GET
/v1/orgs` add the caller's `role`.

### member

`account_id`, `email`, `role` (`admin` or `member`), `inbox_count`, `created_at`, the last being
when the membership was created rather than the account.

### invite

`invite_id`, `org_id`, `email`, `role`, `invited_by` (the admin's `account_id`), `created_at`,
`accepted_at`, which is null while the invite is open.

### audit entry

`audit_id`, `account_id` (who acted), `action`, `target`, `created_at`. `action` is one of
`org.created`, `invite.created`, `invite.revoked`, `member.joined`, `member.role_changed`,
`member.removed`, `inbox.provisioned`, `inbox.deleted`, `key.created` and `key.revoked`. `target`
is the id or address the action names: an org id, an email, an account id, an inbox address, or a
key id. The log is append-only; nothing updates or deletes a row.

### inbox

`inbox_id` (the full address), `username`, `domain`, `display_name`, `created_at`. `display_name` is
the From name on every message the inbox sends, so set it to something a human recipient recognizes;
left null the From header carries the bare address.

### thread

`thread_id`, `inbox_id`, `subject`, `last_message_at`, `message_count`, `participants`. When fetched
individually it also carries `messages`, an array of message objects ordered by `created_at`.

### message

`message_id`, `inbox_id`, `thread_id`, `direction` (`inbound` or `outbound`), `rfc_message_id`,
`in_reply_to`, `references`, `from` (`{address, name}`), `to`, `cc`, `bcc` (arrays of the same
shape), `reply_to`, `subject`, `text`, `html`, `preview`, `labels`, `size`, `has_attachments`,
`attachments`, `created_at`.

### attachment

`attachment_id`, `message_id`, `filename`, `content_type`, `size`, `inline`, `content_id`,
`text_status`.

`text_status` is one of `none` (not a type text is extracted from), `extracted`, `empty` (a
supported type with no text in it), `too_large` (over 10 MiB), or `failed` (the file could not be
parsed). Text is extracted on ingest from PDF (`application/pdf` or a `.pdf` filename) and docx
(`application/vnd.openxmlformats-officedocument.wordprocessingml.document` or a `.docx` filename);
the extracted text is capped at 256 KiB of UTF-8. Outbound attachments are never extracted and are
always `none`.

The attachment objects embedded on a message carry `text_status` and never the text itself, so
message lists stay small. The text is read through the attachment text endpoint or `get_attachment`.

### draft

`draft_id`, `inbox_id`, `kind` (`send` or `reply`), `parent_message_id`, the body fields `to`, `cc`,
`bcc`, `subject`, `text`, `html`, `from`, `reply_to`, `reply_all`, `attachments`, then `send_at`,
`status`, `sent_message_id`, `error`, `created_at`, `updated_at`.

`to`, `cc` and `bcc` are always arrays of addresses, normalized and deduped as the send path
normalizes them. `attachments` carries `{filename, content_type, size}` only: the bytes are stored
in R2 and never returned, so a list of drafts stays small. `sent_message_id` is the `message_id` a successful
send produced, and `error` is `"<code>: <message>"` from the last failed send.

### webhook

`webhook_id`, `url`, `events`, `description`, `active`, `created_at`. `secret` is returned only in
the response that creates it and is never readable again; a lost secret means deleting the webhook
and registering another. A webhook belongs to the account, not to an inbox, so every inbox on the
account feeds it.

## REST endpoints

Base path `/v1`. `:inbox_id` is a full email address and must be URL-encoded in the path. A `+tag`
in it is ignored when the inbox is resolved, so `desk-agent%2Binvoices%40agents.example.com` and
`desk-agent%40agents.example.com` address the same inbox.

### Agent and auth

| Method | Path | Body / query | Returns |
| --- | --- | --- | --- |
| POST | `/agent/signup` | `{email, username?}` | `{api_key, inbox_id, account_id, verified, otp_sent, key_pending}` |
| POST | `/agent/verify` | `{code}` | `{account_id, verified, verified_at}` |
| GET | `/auth/me` | — | `{account, inbox_count, key_id}` |

Signup is unauthenticated, idempotent by `email`, and rate-limited per IP. For a new account it
creates `username@MAIL_DOMAINS[0]`, defaulting `username` to a generated one, returns an active key
(`key_pending` false), and emails the OTP.

For an address that already has an account, verified or not, signup revokes nothing and creates no
second inbox. It returns a **pending** key (`key_pending` true) and emails a fresh OTP, subject to
the per-account hourly cap. A pending key authenticates nowhere except `POST /v1/agent/verify`;
every key already in use keeps working. `POST /v1/agent/verify` with the correct code activates the
pending key, revokes every other key on the account, and marks the account verified if it was not.
That is the lost-key recovery path, and it is why knowing the address alone cannot take the account
over. A wrong or expired code changes nothing.

`otp_sent` is false when the code email could not be sent. Verify called with a non-pending key on
an already verified account returns the current state and consumes no code.

Once an org exists, signup is invite-only for an address that has no account yet: it answers 403
`signup_closed` with `invite required`, and `ALLOWED_SIGNUP_EMAILS` is no longer consulted for it.
An address that holds an open invite signs up exactly as before and additionally joins the org with
the invited role, which closes the invite. An address that already has an account needs no invite:
it takes the repeat-signup path above, so lost-key recovery keeps working for a member and for an
account outside the org, and it joins the org as well when it does hold an open invite. A
deployment with no org keeps the v1 behavior.

### API keys

| Method | Path | Body | Returns |
| --- | --- | --- | --- |
| GET | `/api-keys` | — | `{items, next_page_token: null}` of api_key, never paginated |
| POST | `/api-keys` | `{name?, scopes?}` | api_key including `key` |
| DELETE | `/api-keys/:key_id` | — | `{revoked: true}` |

`scopes` defaults to `["*"]`. An empty array, an entry that is neither `*` nor `inbox:<address>`,
and an `inbox:` entry naming an inbox the account does not own are all 400 `bad_request`. Entries
are lowercased and deduped. `*` may not be mixed with an `inbox:` entry: a list holding both is 400
`bad_request`, so a key is either full access or a list of inboxes.

### Orgs

Company mode. A deployment with no org behaves exactly as v1 does; the bootstrap below is what
turns it on, and it is one org per deployment for now.

| Method | Path | Body / query | Returns |
| --- | --- | --- | --- |
| POST | `/orgs` | `{name}` plus the `x-admin-secret` header | org, 201 |
| GET | `/orgs` | — | `{items, next_page_token: null}` of org with `role`, never paginated |
| GET | `/orgs/:org_id` | — | org with `member_count` |
| POST | `/orgs/:org_id/invites` | `{email, role?}` | invite, 201 |
| GET | `/orgs/:org_id/invites` | — | `{items, next_page_token: null}` of open invite |
| DELETE | `/orgs/:org_id/invites/:invite_id` | — | `{revoked: true}` |
| GET | `/orgs/:org_id/members` | — | `{items, next_page_token: null}` of member |
| PATCH | `/orgs/:org_id/members/:account_id` | `{role}` | member |
| DELETE | `/orgs/:org_id/members/:account_id` | — | `{removed: true}` |
| POST | `/orgs/:org_id/inboxes` | `{account_id, username?, domain?, display_name?}` | inbox, 201 |
| GET | `/orgs/:org_id/audit` | `limit`, `page_token` | `{items, next_page_token}` of audit entry |

`POST /orgs` is the bootstrap. It needs an authenticated, verified account and the deployment's
`ADMIN_SECRET` in the `x-admin-secret` header, creates the org, and makes the caller its admin. A
wrong secret, or one that is absent or shorter than 32 characters, is 403 `forbidden`; an
unverified caller is 403 `forbidden`; a second org is 409 `conflict`.

The operator principal is an admin of every org and needs no membership row, so an operator token
reaches every endpoint here. It holds no membership, so `GET /orgs` is empty for it.

Every endpoint under `/orgs/:org_id` other than `GET /orgs/:org_id` and `GET
/orgs/:org_id/members` is admin-only: a member gets 403 `forbidden` and an account outside the org
gets 404 `not_found`, the same answer as an org that does not exist.

`POST /orgs/:org_id/invites` validates the address exactly as signup does, refuses an address that
is already a member and a second open invite for the same address with 409 `conflict`, defaults
`role` to `member`, and writes an `invite.created` audit row. Nothing is emailed by the invite
itself: the invited address accepts it by calling `POST /v1/agent/signup`, which mails the OTP as
it always has. `DELETE` withdraws an open invite; an accepted or unknown one is 404 `not_found`.

`PATCH .../members/:account_id` changes a role. Demoting the last admin is 409 `conflict`, and so
is removing them. `DELETE .../members/:account_id` drops the membership and revokes every API key
on that account, so the removed member is locked out at once. Their inboxes, threads and messages
are left alone: removing a member does not delete their mail, and an admin who wants the inboxes
gone deletes them explicitly.

`POST /orgs/:org_id/inboxes` provisions an inbox owned by a member. It runs the same `createInbox`
rules as `POST /v1/inboxes`, including `INBOX_LIMIT`, and the inbox counts against that member's
quota rather than the admin's. Members keep creating their own inboxes under the same quota.

`GET /orgs/:org_id/audit` is keyset-paginated by `created_at` descending, breaking ties on
`audit_id` descending. A key created or revoked on an account outside every org writes no row.

### Inboxes

| Method | Path | Body / query | Returns |
| --- | --- | --- | --- |
| GET | `/inboxes` | `limit`, `page_token` | `{items, next_page_token}` of inbox |
| POST | `/inboxes` | `{username?, domain?, display_name?}` | inbox |
| GET | `/inboxes/:inbox_id` | — | inbox |
| DELETE | `/inboxes/:inbox_id` | — | `{deleted: true}` |

`domain` must be one of `MAIL_DOMAINS` and defaults to the first. Creation fails with `conflict`
when the account is at `INBOX_LIMIT`, and with `inbox_taken` when the address exists.

### Threads

| Method | Path | Query | Returns |
| --- | --- | --- | --- |
| GET | `/inboxes/:inbox_id/threads` | `limit`, `page_token` | `{items, next_page_token}` of thread |
| GET | `/inboxes/:inbox_id/threads/:thread_id` | — | thread with `messages` |
| PATCH | `/inboxes/:inbox_id/threads/:thread_id` | body `{add?, remove?}` | thread with `messages` |
| DELETE | `/inboxes/:inbox_id/threads/:thread_id` | — | `{deleted: true}` |

Threads are ordered by `last_message_at` descending.

`PATCH` applies the label change to every message in the thread and returns the thread as `GET`
does. At least one of `add` and `remove` must be a non-empty array. Archiving a thread is that
change, not a separate endpoint:

```json
{ "add": ["archived"], "remove": ["unread"] }
```

`DELETE` removes the thread with every message under it and their stored objects.

### Messages

| Method | Path | Query | Returns |
| --- | --- | --- | --- |
| GET | `/inboxes/:inbox_id/messages` | `labels`, `from`, `to`, `subject`, `since`, `before`, `limit`, `page_token` | `{items, next_page_token}` |
| GET | `/inboxes/:inbox_id/messages/search` | `q`, `limit`, `page_token` | `{items, next_page_token}` |
| GET | `/inboxes/:inbox_id/messages/wait` | `since`, `timeout` | `{items, next_page_token}` |
| GET | `/inboxes/:inbox_id/messages/:message_id` | — | message |
| GET | `/inboxes/:inbox_id/messages/:message_id/raw` | — | `message/rfc822` body |
| PATCH | `/inboxes/:inbox_id/messages/:message_id` | body `{labels}` | message |
| DELETE | `/inboxes/:inbox_id/messages/:message_id` | — | `{deleted: true}` |
| POST | `/inboxes/:inbox_id/messages/labels` | body `{message_ids, add?, remove?}` | `{items}` of message |
| POST | `/inboxes/:inbox_id/messages/delete` | body `{message_ids}` | `{deleted: <count>}` |

`labels` is a comma-separated list and matches messages carrying all of them. `since` and `before`
are Unix milliseconds and bound `created_at`. Messages are ordered by `created_at` descending,
except `wait`, which returns ascending.

`search` is a full-text query over `subject`, the text body, the sender address and the sender
name. `q` is plain words: whitespace separates them, every word must match, and each matches by
prefix, so `invoice` finds `invoices`. Punctuation carries no meaning, and neither do the words
`AND`, `OR`, `NOT` and `NEAR`; they are searched for literally. A `q` of at most 16 words is
accepted, and one that reduces to no searchable word is `bad_request`. Results are ordered by
relevance, weighting a subject hit above a body hit, and break ties on `created_at` descending.
Because that order is not a key, `page_token` here encodes a position in the result set rather than
a message, so a page taken while new mail arrives can shift.

`wait` blocks until a message with `created_at` greater than `since` arrives, or until `timeout`
seconds elapse, whichever comes first. `timeout` defaults to 30 and caps at 55. It polls every 2
seconds and returns an empty `items` array on timeout.

Inbound messages are stored with labels `["received","unread"]`, outbound with `["sent"]`. A label
is at most 64 characters and a message carries at most 20 of them, on `PATCH` and on the batch
endpoints alike.

The two batch endpoints take `message_ids`, a non-empty array of at most 100 ids after duplicates
are dropped; more is 400 `bad_request`. Every id must belong to the inbox, and one that does not
fails the whole request with 404 `not_found` naming the missing ids, changing nothing. Each request
is a single transaction.

`messages/labels` applies `add` then `remove` to every listed message and returns the updated
messages in the order given; at least one of `add` and `remove` must be non-empty.
`messages/delete` removes the messages with their stored objects, drops any thread left empty, and
recounts the threads that survive.

Subaddressing adds one more label automatically. Mail to `desk-agent+invoices@agents.example.com`
lands in the `desk-agent@agents.example.com` inbox with labels `["received","unread","invoices"]`,
and a message sent with a subaddressed `from` is stored with `["sent","invoices"]`. The tag is taken
from the envelope recipient, lowercased and trimmed, as the part after the first `+` in the local
part. A tag that could not be set by `PATCH .../messages/:message_id` — empty, or longer than 64
characters — is dropped and the message is stored with the default labels; it is never a reason to
reject mail. Manual labels are unaffected: `PATCH .../messages/:message_id` replaces the whole set,
tag label included.

### Sending

| Method | Path | Body | Returns |
| --- | --- | --- | --- |
| POST | `/inboxes/:inbox_id/messages/send` | `{to, cc?, bcc?, subject, text?, html?, from?, reply_to?, headers?, attachments?}` | message |
| POST | `/inboxes/:inbox_id/messages/:message_id/reply` | `{text?, html?, from?, reply_all?, attachments?}` | message |
| POST | `/inboxes/:inbox_id/messages/:message_id/forward` | `{to, cc?, bcc?, from?, text?}` | message |

`to`, `cc`, and `bcc` accept a string or an array of strings. At least one recipient is required, at
most 50 across all three. `attachments` are `{filename, content_type, content}` with `content`
base64-encoded; at most 32, and the whole message must stay under 5 MiB.

`reply` sets `In-Reply-To` and `References` from the parent, prefixes the subject with `Re:` if it
is not already, and stays in the parent's thread. `reply_all` merges the parent's `from`, `to`, and
`cc` minus the inbox's own address. `forward` prefixes `Fwd:`, quotes the original, and carries its
attachments.

`from` defaults to the inbox address. It may only be the inbox's own address, optionally
subaddressed: for inbox `desk-agent@agents.example.com`, both `desk-agent@agents.example.com` and
`desk-agent+invoices@agents.example.com` are accepted and anything else answers 400
`invalid_address`. The comparison is made after normalization, so case and the tag do not matter.
With a tag, the From header on the wire carries the subaddressed address under the inbox's
`display_name`, the stored row's `from` is the subaddressed address, and the row is labelled
`["sent", tag]`. Replies then arrive back at the subaddressed address and pick the same label up on
the way in. `reply_to` is separate and unaffected.

The outbound row is stored with `rfc_message_id` set to the `messageId` returned by the send.

### Drafts

| Method | Path | Body / query | Returns |
| --- | --- | --- | --- |
| GET | `/inboxes/:inbox_id/drafts` | `status`, `limit`, `page_token` | `{items, next_page_token}` of draft |
| POST | `/inboxes/:inbox_id/drafts` | `{kind?, parent_message_id?, to?, cc?, bcc?, subject?, text?, html?, from?, reply_to?, reply_all?, attachments?, send_at?}` | draft, 201 |
| GET | `/inboxes/:inbox_id/drafts/:draft_id` | — | draft |
| PATCH | `/inboxes/:inbox_id/drafts/:draft_id` | any body field, plus `send_at` | draft |
| DELETE | `/inboxes/:inbox_id/drafts/:draft_id` | — | `{deleted: true}` |
| POST | `/inboxes/:inbox_id/drafts/:draft_id/send` | — | message, 201 |

A draft is a message composed now and sent later, by hand or on a schedule. `kind` defaults to
`send`, or to `reply` when `parent_message_id` is given; the two disagreeing is 400 `bad_request`,
and a `parent_message_id` the inbox does not hold is 404 `not_found`. A `send` draft takes the
`send` body and a `reply` draft the `reply` body: `to`, `cc`, `bcc`, `subject` and `reply_to` on a
reply draft, and `reply_all` on a send draft, are 400 `bad_request`, exactly as those fields are
absent from the matching send endpoint. `headers` is not a draft field.

The body is validated on every write by building the message the send would build, so a draft that
could never be sent — no recipient, no `text` and no `html`, a `from` that is not the inbox, an
invalid address, too many recipients or attachments, over 5 MiB — fails at create or update with
the error the send itself would return. The verification gate is not applied at write time: an
unverified account may hold a draft addressed to anyone and gets `message_rejected` when it is
sent.

Statuses are `draft`, `scheduled`, `sending`, `sent` and `failed`.

| From | To | Cause |
| --- | --- | --- |
| — | `draft` | create without `send_at` |
| — | `scheduled` | create with `send_at` |
| `draft` | `scheduled` | update setting a future `send_at` |
| `scheduled` | `draft` | update setting `send_at` to null |
| `draft`, `scheduled`, `failed` | `sending` | the drain claims a due draft, or `/send` is called |
| `sending` | `sent` | the send succeeded; `sent_message_id` is set |
| `sending` | `failed` | the send failed; `error` is set |
| `failed` | `scheduled` | update setting a future `send_at` |

`send_at` is Unix milliseconds and must be in the future; a past or non-integer value is 400
`bad_request`. A cron trigger runs every minute, so a scheduled draft is sent in the minute after
`send_at`, never before it; scheduling is minute-granular in practice. Each run takes at most 50 due
drafts, oldest `send_at` first, and claims each one with a conditional update, so two overlapping
runs cannot send the same draft twice. Delivery is at least once in principle: a Worker killed
between the send and the status write leaves the draft `sending`, which is never picked up again and
is visible for an operator to inspect.

A `sent` or `sending` draft cannot be updated and answers 409 `conflict`; a `sending` draft cannot
be deleted. A failed draft is kept for inspection with its `error`, is not retried, and is
re-scheduled by an update carrying a new `send_at`. Any successful update clears `error`, and a
`send_at` already in the past at update time is dropped rather than firing immediately, leaving the
draft unscheduled.

`POST .../send` sends the draft now whatever its `send_at`, through the same `sendMessage` and
`replyToMessage` path the send and reply endpoints use, so limits, the verification gate, labels and
threading are identical. It returns the sent message and marks the draft `sent`. A failed send
marks the draft `failed` and returns the error.

Drafts are ordered by `updated_at` descending. `status` filters the list and must be one of the five
statuses.

### Attachments

| Method | Path | Returns |
| --- | --- | --- |
| GET | `/inboxes/:inbox_id/messages/:message_id/attachments/:attachment_id` | attachment bytes with its `content_type` and a `content-disposition` filename |
| GET | `/inboxes/:inbox_id/messages/:message_id/attachments/:attachment_id/text` | the extracted text as `text/plain; charset=utf-8`, `404 not_found` when `text_status` is not `extracted` |

### Webhooks

| Method | Path | Body | Returns |
| --- | --- | --- | --- |
| GET | `/webhooks` | — | `{items, next_page_token: null}` of webhook, never paginated |
| POST | `/webhooks` | `{url, events?, description?}` | webhook including `secret` |
| GET | `/webhooks/:webhook_id` | — | webhook |
| PATCH | `/webhooks/:webhook_id` | `{url?, events?, description?, active?}` | webhook |
| DELETE | `/webhooks/:webhook_id` | — | `{deleted: true}` |

`url` must be `https://`; anything else is 400 `bad_request`. `events` defaults to both names, and
every entry must be `message.received` or `message.sent`; an unknown name or an empty array is 400
`bad_request`. An account holds at most 10 webhooks and the eleventh is 409 `conflict`. `PATCH`
leaves omitted fields alone, and `active: false` stops delivery without dropping the endpoint or
rotating its secret.

#### Event payload

Every delivery is a `POST` carrying this body:

```json
{
  "event": "message.received",
  "delivery_id": "dlv_...",
  "created_at": 1757345000000,
  "data": { "message_id": "msg_...", "inbox_id": "desk-agent@agents.example.com" }
}
```

`data` is the whole message object, the same shape `GET
/v1/inboxes/:inbox_id/messages/:message_id` returns. `message.received` fires once an inbound
message and its attachments are stored, `message.sent` once an outbound row is stored, which is
after the send itself succeeded.

The payload is read from storage when the delivery is attempted, not when the event fires, so it
reflects the message as it stands at delivery time: labels changed between the two arrive with
their later value. A message deleted before its delivery produces no delivery at all.

#### Headers and signature

| Header | Value |
| --- | --- |
| `content-type` | `application/json` |
| `x-intray-event` | the event name |
| `x-intray-delivery` | the `delivery_id`, the same across retries |
| `x-intray-timestamp` | Unix **seconds** at the moment of the attempt |
| `x-intray-signature` | `v1=<hex>` |

`<hex>` is a lowercase hex HMAC-SHA256 over `<timestamp>.<raw body>` keyed with the webhook's
`secret`. Verify it against the raw request bytes before parsing them:

```ts
async function verify(secret: string, request: Request): Promise<boolean> {
  const body = await request.text();
  const timestamp = request.headers.get("x-intray-timestamp") ?? "";
  const presented = (request.headers.get("x-intray-signature") ?? "").replace(/^v1=/, "");
  const signature = Uint8Array.from(presented.match(/../g) ?? [], (pair) => Number.parseInt(pair, 16));
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["verify"],
  );
  const payload = new TextEncoder().encode(`${timestamp}.${body}`);
  return crypto.subtle.verify("HMAC", key, signature, payload);
}
```

Reject a timestamp far from your own clock to bound replay.

#### Delivery and retries

Deliveries run through a Cloudflare queue, so a slow endpoint never holds up inbound mail or a
send. Each attempt times out after 10 seconds. Any 2xx acknowledges the delivery; any other status,
a network error, or the timeout retries it, at most 5 times, after which it is dropped. The delay
doubles with each attempt and is capped at an hour, so the five retries land 1, 2, 4, 8 and 16
minutes after their attempt. It is set per message, which is why the queue carries no `retry_delay`
of its own. Delivery is at-least-once and unordered: deduplicate on `delivery_id`. A delivery for a
webhook that has since been deleted or deactivated is discarded rather than retried.

### Usage

| Method | Path | Returns |
| --- | --- | --- |
| GET | `/usage` | the usage object below |

```json
{
  "period": "2026-09",
  "messages_sent": 12,
  "messages_received": 40,
  "storage_bytes": 918273,
  "inboxes": 2,
  "limits": {
    "messages_sent": null,
    "messages_received": null,
    "storage_bytes": null,
    "inboxes": 10
  }
}
```

`period` is the current UTC month. `messages_sent` and `messages_received` count that month;
`storage_bytes` is a running total that is not reset by a new month, and `inboxes` is counted live.
A `null` limit is unlimited; `limits.inboxes` is `INBOX_LIMIT` and is never null.

`storage_bytes` counts, per message, the size recorded on the message row plus the size of each
stored attachment: for received mail the raw MIME object plus each attachment object, for sent mail
the composed message plus each attachment object. Every delete path gives the bytes back: message
delete, batch delete, thread delete and inbox delete. Draft attachments do not count.

Quotas are enforced where the work happens, not on this endpoint. A send, reply, forward or draft
send past `QUOTA_MESSAGES_SENT_PER_MONTH` answers 429 `quota_exceeded` before the message is built.
Inbound mail past `QUOTA_MESSAGES_RECEIVED_PER_MONTH`, or that would push `storage_bytes` past
`QUOTA_STORAGE_BYTES`, is rejected with `552 quota exceeded` before anything is written. Creating an
inbox past `INBOX_LIMIT` keeps its 409 `conflict`. The operator principal is exempt from all three
quotas, and its own usage is still counted.

### Service endpoints

| Method | Path | Returns |
| --- | --- | --- |
| GET | `/healthz` | `{ok: true}` |
| GET | `/skill.md` | onboarding markdown |
| GET | `/llms.txt` | the same markdown |
| GET | `/openapi.json` | the OpenAPI 3.1 document for this contract |

`/openapi.json` needs no key, is `application/json` under `cache-control: public, max-age=300`, and
is built once per isolate. `servers` carries `PUBLIC_URL`, `components.securitySchemes` covers both
the bearer key and the `X-API-Key` header, and every operation names the error codes above with the
error envelope as its body. It describes the four service endpoints as well as every `/v1` one; a
test walks the Hono router and fails when a route is added without its entry.

## MCP

Streamable HTTP at `/mcp`. A fresh `McpServer` is built per request. The key is read from the
request headers before the handler runs, and which tool set is registered depends on whether it
resolved to a live account.

Tool arguments use the same names and semantics as the REST bodies and queries above.

### Unauthenticated tool set

| Tool | Arguments |
| --- | --- |
| `signup` | `email`, `username?` |
| `verify` | `api_key`, `code` |
| `read_onboarding_docs` | — |

Server instructions explain that the caller should sign up, ask its human for the emailed code,
verify, and then store the key as an `Authorization` header on this endpoint.

### Authenticated tool set

| Tool | Arguments |
| --- | --- |
| `auth_me` | — |
| `list_inboxes` | `limit?`, `page_token?` |
| `create_inbox` | `username?`, `domain?`, `display_name?` |
| `get_inbox` | `inbox_id` |
| `delete_inbox` | `inbox_id` |
| `list_threads` | `inbox_id`, `limit?`, `page_token?` |
| `get_thread` | `inbox_id`, `thread_id` |
| `update_thread_labels` | `inbox_id`, `thread_id`, `add?`, `remove?` |
| `delete_thread` | `inbox_id`, `thread_id` |
| `list_messages` | `inbox_id`, `labels?`, `from?`, `to?`, `subject?`, `since?`, `before?`, `limit?`, `page_token?` |
| `search_messages` | `inbox_id`, `q`, `limit?`, `page_token?` |
| `get_message` | `inbox_id`, `message_id` |
| `wait_for_message` | `inbox_id`, `since?`, `timeout?` |
| `send_message` | `inbox_id`, `to`, `cc?`, `bcc?`, `subject`, `text?`, `html?`, `from?`, `reply_to?`, `attachments?` |
| `reply_to_message` | `inbox_id`, `message_id`, `text?`, `html?`, `from?`, `reply_all?`, `attachments?` |
| `forward_message` | `inbox_id`, `message_id`, `to`, `cc?`, `bcc?`, `from?`, `text?` |
| `update_message_labels` | `inbox_id`, `message_id`, `labels` |
| `delete_message` | `inbox_id`, `message_id` |
| `batch_update_labels` | `inbox_id`, `message_ids`, `add?`, `remove?` |
| `batch_delete_messages` | `inbox_id`, `message_ids` |
| `get_attachment` | `inbox_id`, `message_id`, `attachment_id` |
| `create_draft` | `inbox_id`, `kind?`, `parent_message_id?`, `to?`, `cc?`, `bcc?`, `subject?`, `text?`, `html?`, `from?`, `reply_to?`, `reply_all?`, `attachments?`, `send_at?` |
| `list_drafts` | `inbox_id`, `status?`, `limit?`, `page_token?` |
| `get_draft` | `inbox_id`, `draft_id` |
| `update_draft` | `inbox_id`, `draft_id`, any body field, `send_at?` |
| `delete_draft` | `inbox_id`, `draft_id` |
| `send_draft` | `inbox_id`, `draft_id` |
| `create_api_key` | `name?`, `scopes?` |
| `get_usage` | — |
| `create_org` | `name`, `admin_secret` |
| `list_orgs` | — |
| `get_org` | `org_id` |
| `create_invite` | `org_id`, `email`, `role?` |
| `list_invites` | `org_id` |
| `revoke_invite` | `org_id`, `invite_id` |
| `list_members` | `org_id` |
| `update_member` | `org_id`, `account_id`, `role` |
| `remove_member` | `org_id`, `account_id` |
| `provision_inbox` | `org_id`, `account_id`, `username?`, `domain?`, `display_name?` |
| `list_audit` | `org_id`, `limit?`, `page_token?` |
| `list_webhooks` | — |
| `create_webhook` | `url`, `events?`, `description?` |
| `get_webhook` | `webhook_id` |
| `update_webhook` | `webhook_id`, `url?`, `events?`, `description?`, `active?` |
| `delete_webhook` | `webhook_id` |

Every tool returns its result as JSON in a single text content block. An `AppError` becomes a tool
error (`isError: true`) whose text is `{"error":{"code":...,"message":...}}`, matching the REST
shape.

Differences from REST, all deliberate:

- `signup` over MCP has no client IP, so the per-IP rate limit does not apply; the per-account OTP
  cap still does.
- `verify` takes `api_key` explicitly because the session that called `signup` carries no header
  yet.
- `read_onboarding_docs` returns `{"markdown": ...}`, the content of `/skill.md`.
- `get_attachment` returns the attachment object plus `download_url` (the authenticated REST
  download path under `PUBLIC_URL`) and, where there is one, a `text`: the text extracted from a
  PDF or docx on ingest, otherwise the decoded body when `content_type` is `text/*` and `size` is
  at most 64 KiB. `text_status` says why `text` is absent.
- `labels` on `list_messages` accepts a string or an array; `since`, `before`, `limit`, and
  `timeout` are numbers.
- `send_message` has no `headers` argument.
- `update_draft` takes `send_at` as a number or null; null unschedules the draft.
- `create_org` takes `admin_secret` as an argument, because an MCP tool call carries no headers of
  its own. It is the same secret the `x-admin-secret` header carries over REST.
- The org tools are registered for every authenticated principal, and the ones that need an admin
  answer `forbidden` for a member, so the tool count does not depend on the caller's role. Server
  instructions gain one sentence naming them when the principal administers an org.
