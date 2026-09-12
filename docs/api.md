# API contract

Source of truth for the HTTP and MCP adapters. Both call the same `src/core` functions; anything
below that differs between the two surfaces is a bug.

All JSON field names are snake_case. All timestamps are integer Unix milliseconds.

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
| `OPERATOR_TOKEN` | a **secret**, not a var. Set with `pnpm wrangler secret put OPERATOR_TOKEN` or `pnpm run setup --operator-token`, never in `wrangler.jsonc`. Authenticates the operator principal. Absent, empty, or shorter than 32 characters disables it. Put it in `.dev.vars` for `pnpm dev` |

Addresses in `ALLOWED_SIGNUP_EMAILS` are compared lowercased and trimmed. `pnpm run setup
--allow-signup you@example.com,teammate@example.com` writes the var.

## Errors

```json
{ "error": { "code": "not_found", "message": "inbox not found" } }
```

| Status | Code |
| --- | --- |
| 400 | `bad_request`, `invalid_address`, `invalid_code` |
| 401 | `unauthorized` |
| 403 | `forbidden`, `message_rejected`, `signup_closed` |
| 404 | `not_found` |
| 409 | `conflict`, `inbox_taken` |
| 429 | `too_many_requests` |
| 500 | `internal_error` |

`message_rejected` is returned when an unverified account tries to send to any address other than
its own `accounts.email`. `signup_closed` is returned when `ALLOWED_SIGNUP_EMAILS` is set and the
address is not in it. `email reserved` is returned when a signup names the operator address.

## Status codes

Creates return 201: signup, inbox create, api key create, send, reply, forward. Everything else
returns 200. Bodies that are entirely optional (`POST /api-keys`, `POST /inboxes`, `.../reply`) may
be omitted and are read as `{}`.

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

### API keys

| Method | Path | Body | Returns |
| --- | --- | --- | --- |
| GET | `/api-keys` | — | `{items, next_page_token: null}` of api_key, never paginated |
| POST | `/api-keys` | `{name?}` | api_key including `key` |
| DELETE | `/api-keys/:key_id` | — | `{revoked: true}` |

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

### Attachments

| Method | Path | Returns |
| --- | --- | --- |
| GET | `/inboxes/:inbox_id/messages/:message_id/attachments/:attachment_id` | attachment bytes with its `content_type` and a `content-disposition` filename |
| GET | `/inboxes/:inbox_id/messages/:message_id/attachments/:attachment_id/text` | the extracted text as `text/plain; charset=utf-8`, `404 not_found` when `text_status` is not `extracted` |

### Service endpoints

| Method | Path | Returns |
| --- | --- | --- |
| GET | `/healthz` | `{ok: true}` |
| GET | `/skill.md` | onboarding markdown |
| GET | `/llms.txt` | the same markdown |

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
| `create_api_key` | `name?` |

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
