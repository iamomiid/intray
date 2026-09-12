# Architecture

How intray is put together and why. `docs/api.md` is the wire contract; this file is the design
behind it.

## Components

One Cloudflare Worker holds every surface. `src/index.ts` routes `/mcp` to the MCP handler and
everything else to the Hono app, and exports the `email()` handler that Email Routing calls and the
`scheduled()` handler a one-minute cron trigger calls to drain due drafts.
`queue()` handler that drains webhook deliveries.

```
Email Routing rule/catch-all ─────► email()        ─┐
POST /v1/inbound (provider, MTA) ──► receiveInbound ─┴─► ingestInbound ──► postal-mime
                                                            ├─► D1 (thread and message rows)
                                                            └─► R2 (raw .eml, attachments)
POST /v1/inbound/bounces (provider) ──► recordProviderBounce ──► D1 (suppressions)
HTTP /v1/*  (Hono)  ─┐
                     ├──► src/core/* ──► src/db/* ──► D1
MCP  /mcp           ─┘                ├─► R2, MailTransport ──► EMAIL | SMTP | SES | Resend
                                      └─► env.WEBHOOKS ──► queue() ──► subscriber's endpoint
```

| Layer | Path | Role |
| --- | --- | --- |
| adapters | `src/http/`, `src/mcp/` | parse and validate input, call core, format the result |
| services | `src/core/` | the only place with business logic |
| storage | `src/db/` | typed D1 helpers, one module per table |
| mail | `src/email/` | inbound ingest, threading, MIME parsing, outbound builders, the transports |
| schemas | `src/schemas/` | zod input and response shapes shared by MCP and the OpenAPI document |
| helpers | `src/lib/` | ids, otp, hash, errors, pagination, address, limits, rfc, time |
| setup | `scripts/` | the operator command that provisions a deployment |
| cron | `triggers.crons` in `wrangler.jsonc` | `* * * * *`, calling `scheduled()` and so `drainDueDrafts` |
| waiter | `src/waiter.ts` | `InboxWaiter`, one Durable Object per inbox, parking `wait` calls until an ingest wakes them |

Bindings: `DB` (D1), `BUCKET` (R2), `EMAIL` (`send_email`, remote), `RATE` (rate limit),
`WEBHOOKS` (a producer on the `intray-webhooks` queue, consumed by this same Worker),
`INBOX_WAITER` (the `InboxWaiter` Durable Object namespace, optional), and the
vars `MAIL_DOMAINS`, `INBOX_LIMIT`, `PUBLIC_URL`, `ALLOWED_SIGNUP_EMAILS`,
`QUOTA_MESSAGES_SENT_PER_MONTH`, `QUOTA_MESSAGES_RECEIVED_PER_MONTH`, `QUOTA_STORAGE_BYTES`,
`SPAM_LABEL_THRESHOLD`, `SPAM_REJECT_THRESHOLD`, `ROUTING_MODE`, `MAIL_TRANSPORT`,
`CLOUDFLARE_ZONE_ID` and
`WORKER_NAME` plus the `OPERATOR_TOKEN`, `ADMIN_SECRET`, `INBOUND_SECRET`
and `ROUTING_API_TOKEN` secrets, and the per-transport secrets `docs/api.md` lists.
`src/env.ts` turns the vars into a `Config`; the
secrets are read from `Env` directly, since none has a parsed form. `Env` also carries an optional
`MAIL`, a `MailTransport` used ahead of `MAIL_TRANSPORT` when it is set, which is how the suites
inject a fake and the one seam a binding-shaped transport would arrive through.

## Inbound

`handleEmail(message, env, ctx)` reads `message.raw` into a `Uint8Array` sized by `message.rawSize`
and calls `ingestInbound(env, {envelopeFrom, envelopeTo, raw})`, which runs:

1. reject when `raw.byteLength` exceeds `INBOUND_MAX_BYTES` (`552 message too large`);
2. `splitTag(envelopeTo)` then `getInbox` on the base address, rejecting an unknown recipient
   (`550 no such inbox`); the `+tag` is stripped for the lookup, so tagged addresses land in the
   base inbox, and it is kept for step 8;
3. `withinInboundQuota` on the owning account, rejecting a message past the received or storage
   quota (`552 quota exceeded`) before anything is written;
4. `parseMime(raw)` through `postal-mime`, yielding a `ParsedEmail` with bare RFC identifiers, the
   raw header list, and a `preview` derived from the text body, or from tag-stripped html when
   there is none;
5. `scoreSpam(parsed, envelopeFrom)`, rejecting an executable attachment (`550 attachment type not
   accepted`) and a score at or above `SPAM_REJECT_THRESHOLD` (`550 rejected as spam`), still
   before anything is written;
6. `BUCKET.put("raw/{message_id}.eml")` and `BUCKET.put("att/{message_id}/{n}")` per attachment;
7. `resolveThreadId` matching `[inReplyTo, ...references]` against `messages.rfc_message_id` in the
   same inbox, else a new `thr_` row whose subject and participants come from this message;
8. `insertMessage` with `direction: "inbound"`, labels `["received","unread"]` — or
   `["received","spam"]` from step 5 — plus `bounce` when the message is a delivery status
   notification, `dmarc` when an attachment parses as an aggregate report, and the recipient's tag
   when it can be a label, `size`, `has_attachments`, `raw_key`, `spam_score` and
   `spam_reasons_json`, then one `insertAttachment` per stored object;
9. `touchThread`, which bumps `last_message_at`, rewrites `participants_json`, fills a missing
   subject, and increments `message_count`, then one suppression row per bounced address and one
   `dmarc_reports` row with its records per aggregate report.

Rejections are thrown as `InboundRejected` and turned into `message.setReject(reason)` by
`handleEmail`. Anything else propagates, so Cloudflare retries or bounces.

Threading has no subject-based fallback: a reply from a client that drops both `In-Reply-To` and
`References` starts a new thread.

### Inbound adapters

`ingestInbound` knows nothing about Email Routing, so `handleEmail` is one adapter over it and
`POST /v1/inbound` is a second, for SES over SNS or S3, a Resend inbound webhook, or a self-hosted
MTA. `src/core/inbound.ts` holds both halves of it: `requireInboundSecret`, a constant-time compare
against `INBOUND_SECRET` that is disabled below 32 characters like the other two secrets, and
`receiveInbound`, which turns an `InboundRejected` into `400 rejected` carrying the same `550` or
`552` reason so the caller can bounce with it. The route reads a `message/rfc822` body plus the two
envelope headers, or a JSON body whose `raw` is base64. It is not rate limited by `RATE`, because
the caller is a mail provider rather than an agent, and the secret is what bounds it.

`POST /v1/inbound/bounces` is the same secret over the suppression list. `src/email/notifications.ts`
is a pure parser from the SES-over-SNS, Resend and generic shapes to `{provider, from,
recipients}`, and `recordProviderBounce` writes one row per address with source `provider` and
reason `provider` or `soft_bounce`. The sending address in the notification is what picks the
account, so a provider that reports a bounce for an address this deployment never sent from is 404
rather than a row on someone else's list. An SNS `SubscriptionConfirmation` is answered by fetching
its `SubscribeURL` once. Signatures are not verified: that is the deliberate v1 limit recorded in
`docs/status.md`, and the secret carries the whole of the authentication.

### Spam

`src/email/spam.ts` scores every inbound message before the first write.
`scoreSpam(parsed, envelopeFrom)` is pure: it reads the parsed message, its raw headers and its
attachment bytes and returns `{score, reasons}`. Each reason is a short stable token, the score is
the sum of the reasons' weights capped at 100, and the whole weight table is the one `SPAM_WEIGHTS`
const at the top of the module so a reader can audit it in one place. Nothing here calls out of the
Worker and nothing is remembered between messages, so the same mail always scores the same.

| Reason | Weight | Signal |
| --- | --- | --- |
| `spf_fail` | 25 | `Authentication-Results` says `spf=fail` |
| `spf_softfail` | 10 | `Authentication-Results` says `spf=softfail` |
| `dkim_fail` | 20 | `Authentication-Results` says `dkim=fail` |
| `dkim_none` | 8 | `Authentication-Results` says `dkim=none` |
| `dmarc_fail` | 30 | `Authentication-Results` says `dmarc=fail` |
| `missing_message_id` | 10 | no `Message-ID` |
| `missing_date` | 5 | no parsable `Date` |
| `from_display_address` | 20 | the `From` display name holds an address other than the `From` address |
| `reply_to_other_domain` | 10 | `Reply-To` is on a different registrable domain than `From` |
| `from_not_envelope_domain` | 12 | the `From` domain is not the envelope sender's |
| `subject_all_caps` | 8 | the subject has 12 letters or more and no lowercase one |
| `subject_punctuation` | 8 | more than three `!` and `$` between them |
| `subject_fake_reply` | 10 | `RE:`, `FW:` or `FWD:` with no `In-Reply-To` and no `References` |
| `html_only` | 6 | an html body with no text alternative |
| `html_thin_with_links` | 12 | html whose visible text is under 80 characters and that carries a link |
| `many_link_domains` | 8 | more than five distinct registrable link domains |
| `link_text_mismatch` | 20 | link text shows one domain while the `href` points at another |
| `mostly_urls` | 10 | over half of a body of 40 characters or more is URL |
| `list_unsubscribe` | 3 | `List-Unsubscribe` is present |
| `precedence_bulk` | 5 | `Precedence` is `bulk` or `junk` |
| `attachment_executable` | 60 | an attachment's extension is executable |
| `attachment_double_extension` | 40 | a document extension followed by another, as in `invoice.pdf.exe` |
| `attachment_script` | 30 | a script extension, loose or inside a zip |
| `attachment_macro_office` | 25 | an Office content type with a `docm`, `xlsm` or `pptm` extension |
| `archive_executable` | 60 | a zip holding an executable extension |
| `archive_unknown` | 15 | a zip whose entries cannot be listed, or one over 4 MiB |

`Authentication-Results` is what Cloudflare Email Routing stamps on delivery. The header name is
matched case-insensitively, every instance is read, and the first result found for a method wins; a
message with no such header contributes no authentication signal at all rather than a penalty,
because a deployment behind another MTA may not get one.

**Policy.** `config(env).spam` holds `SPAM_LABEL_THRESHOLD`, default 50, and
`SPAM_REJECT_THRESHOLD`, default 90 and never rejecting at `0`. At or above the reject threshold
the message is refused with `550 rejected as spam` and nothing is written, so the sending MTA is
told rather than the mail disappearing. At or above the label threshold it is stored with labels
`["received","spam"]` — `spam` instead of `unread`, so an agent filtering on `unread` does not see
it and one filtering on `spam` does. Below both it is stored normally. The score and the reasons
land on the row either way, including on a message nobody labelled, so an operator can tune the
thresholds against what actually arrived.

**There is no antivirus engine.** A Worker cannot run one, and nothing here inspects file contents
for known malware. What it does instead is refuse the shapes that carry it, and the extensions are
two lists. An attachment whose extension is `exe`, `com`, `scr`, `pif`, `bat`, `cmd`, `msi`, `hta`,
`lnk`, `vbs`, `ps1` or `jar`, and a zip holding one, are rejected with `550 attachment type not
accepted` whatever the score and whatever the thresholds, because that decision should not move
when an operator tunes spam; the double-extension rule sits on this list too. A script extension —
`js`, `jse`, `wsf`, `sh`, `py`, `rb` or `pl` — is scored and never refused, loose or inside a zip,
because this inbox is read by agents and developers and source code travels by mail. Zip entries
are listed through `fflate`'s `unzipSync` with a filter that returns `false` for every entry, so
the central directory is read and nothing is decompressed; a zip that cannot be read, or one over
4 MiB, scores as unknown rather than being trusted. Macro-enabled Office documents are scored, not
refused, because they are often legitimate.

### Routing

Inbound reaches the Worker one of two ways, chosen by `ROUTING_MODE`.

`catch_all`, the default, points the zone's Email Routing catch-all at the Worker. It is one rule
for the whole zone, so the MX accepts mail for every address on the domain and the Worker is what
rejects an unknown recipient, at step 2, with `550 no such inbox`. That is cheap to run and wrong in
two ways: address harvesters and reputation systems see a domain that accepts everything, and the
catch-all claims the whole zone, so no other address on the domain can be held by anything else.

`per_inbox` gives every inbox its own rule: a `literal` matcher on the full address and a `worker`
action naming `WORKER_NAME`. The domain then accepts mail only for addresses that exist, and the
operator's own addresses on the same zone keep their own rules. `src/lib/cloudflare.ts` is the
client — `fetch` against `/zones/{zone}/email/routing/rules`, mapping Cloudflare's error envelope
onto an `AppError` — and `src/core/routing.ts` is the only place a client is built, for the zone
client custom domains use as well. It is deliberately separate from
`scripts/lib/cloudflare.ts`, which is the Node-side client the setup uses.

`createInbox` creates the rule **before** the row and stores its id in `inboxes.routing_rule_id`, so
a rule that cannot be created fails the create and an inbox never exists without its route; the
reverse ordering would leave an inbox that silently receives nothing. `deleteInbox` removes the rule
before the row, and a 404 for the rule is treated as already removed. Cloudflare caps rules per
zone, which bounds the total inbox count across accounts; that error surfaces as 409 `conflict` with
`inbox limit reached`, exactly as the per-account `INBOX_LIMIT` does, because from the agent's side
it is the same fact. Missing zone id or token is 503 `routing_unavailable`.

The inbox object carries `routing`, `rule` or `catch_all`, read off the column rather than off the
mode, so an agent can see how its own inbox is actually reached.

The Worker's `550 no such inbox` stays in both modes: it is the backstop for `catch_all` and for a
stale rule that outlived its inbox.

`pnpm run setup` reconciles the two sides. In `per_inbox` mode the **Routing rules** step lists the
zone's rules and the deployment's inboxes and fixes drift both ways: it creates a rule for an inbox
that has none, adopts the id of a rule that already exists for an inbox whose row does not know it,
and deletes a rule that targets the Worker for an address with no inbox. Switching a live
deployment creates the rules first and disables the catch-all last, so no address is unreachable in
between, and because that changes how the domain's mail flows it goes through the same consent flow
as the other irreversible steps. Switching back re-enables the catch-all and leaves the rules in
place, which is why the switch is described as reversible.

### Custom domains

An account registers a domain of its own with `POST /v1/domains` and, once it verifies, creates
inboxes on it. `src/core/domains.ts` is the whole of it; `src/lib/cloudflare.ts` gains a second
client, `zoneClient`, alongside the routing one — same token, same error mapping, no shared state.

**A custom domain must be a zone in the operator's Cloudflare account, or a subdomain of one.**
`findZone` walks the same candidates the setup's `zoneCandidates` walks, from the full name up to
the registrable apex, and the first `GET /zones?name=` that answers with a zone wins; nothing else
is supported and a domain whose zone the account does not hold is 400 `bad_request` saying so. The
reason is that everything the feature does is a zone-level write — Email Sending onboarding, the
Email Routing enable, the SPF, DKIM and MX records, and the per-inbox routing rule — and Cloudflare
will only do those on a zone the account holds. A design where the agent's own registrar keeps the
zone would mean handing back records for a human to enter by hand, waiting on DNS the deployment
cannot see, and no way to reach `verified` on the deployment's own evidence. Delegating a subdomain
to the operator's account is the shape that makes that work, so that is the shape the API asks for.

`addDomain` resolves the zone, onboards the domain for sending, enables Email Routing on the zone
when it is off, reads the DNS Cloudflare wants from both the sending status and the routing status,
and writes each record the zone is missing. It stores the row `pending` with those records and the
sending tag. Records are written one by one rather than through Cloudflare's own `POST .../dns`
fixer so that the row knows exactly what it created and `deleteDomain` can take it back out again;
a record whose content already matches is left alone, and an existing SPF, DMARC or CNAME with the
same name is updated in place rather than duplicated. Every Cloudflare failure lands the row as
`failed` with the message instead of unwinding, because the row is the only record of the attempt
and an agent that cannot see the failure cannot fix it.

`verifyDomain` re-runs the same sequence, which is idempotent end to end, and settles on what
Cloudflare reports: both statuses clean turns the domain `verified` with `verified_at`, anything
outstanding leaves it `pending` with the current records and their `present` flags. It is therefore
also the retry for a `failed` domain, so there is one call to poll and no second repair endpoint.

`createInbox` accepts a domain that is `verified` and owned by the calling account on top of
`MAIL_DOMAINS`, and on a custom domain the inbox always gets its own routing rule on that domain's
zone whatever `ROUTING_MODE` says: the deployment's catch-all lives on a different zone and cannot
reach the address, so a rule is the only route there is. `createRoutingRule` and `deleteRoutingRule`
take a zone id for that reason, defaulting to `CLOUDFLARE_ZONE_ID` and the mode when it is null.
`deleteInbox` looks the zone up from the domain row. `deleteDomain` is refused while any inbox is
on the domain, so an inbox is never stranded, and otherwise removes the records the row created,
the sending subdomain and the row.

Inbound does not change. Mail for a custom domain arrives at the same `email()` handler through the
per-inbox rule and is ingested by `inbox_id` like any other, so nothing in `src/email/` knows a
custom domain exists.

The token is `ROUTING_API_TOKEN`, reused rather than added to. For custom domains it must be scoped
to all zones in the account with Zone Read, DNS Edit, Email Routing Rules Edit and Email Routing
Addresses Edit; a missing token is 503 `routing_unavailable`, exactly as `per_inbox` mode answers.

### Bounces

`detectBounce` in `src/email/bounce.ts` runs over the parsed message between step 4 and step 7, and
what it returns decides both the `bounce` label written in step 7 and the suppression rows written
after step 8. It recognizes a report two ways. A `multipart/report` whose `Content-Type` carries
`report-type=delivery-status` is read from its `message/delivery-status` parts; postal-mime hands
those parts back as attachments with that MIME type and exposes the top-level headers, so the
content type parameter is read off the raw header rather than reconstructed. A `text/plain` message
from `mailer-daemon@` or `postmaster@` carrying `Auto-Submitted: auto-replied` and a `Status:` line
is read from its text body with the same field parser, which covers the MTAs that inline the DSN
fields instead of building the report structure. Both paths unfold continuation lines, split the
body into blank-line-separated blocks, and take from each block with a `Final-Recipient` the
address, the `Action`, the enhanced `Status` and the `Diagnostic-Code`. A `failed` action with a
`5.x.x` status is a hard bounce, a `4.x.x` status or a `delayed` action is a soft one, and anything
else is not a bounce, so a `delivered` or `relayed` notification suppresses nothing.

`recordBounce` in `src/core/suppressions.ts` then writes one row per recipient: a hard bounce is an
upsert with reason `hard_bounce`, source `dsn`, the diagnostic as `detail` and the stored bounce
message's id as `message_id`, so the report can be read back; a soft bounce bumps `last_seen_at` on
an existing row and otherwise inserts a bare `soft_bounce` row, which means a soft bounce never
downgrades a hard one. `message.bounced` is emitted through `emitEvent` alongside
`message.received`. Like the counters and the events, none of this can fail an ingest: detection is
wrapped and `recordBounce` swallows and logs per recipient, because a report we cannot read must
not bounce mail back at the sending MTA.

The bounce is not a second kind of row. It is an ordinary inbound message with one more label, so
an agent reads it with `list_messages {"labels":"bounce"}` and the raw report is in R2 like any
other; only the suppression list is new state.

### DMARC

`src/email/dmarc.ts` reads a DMARC aggregate report out of an attachment, and runs over the parsed
attachments between step 4 and step 7 like `detectBounce` does. An attachment is a candidate when
its content type is `application/gzip`, `application/x-gzip`, `application/gzip-compressed`,
`application/zip` or `application/x-zip-compressed`, or when its filename ends `.gz` or `.zip`;
anything else is skipped without being decompressed. gzip goes through `fflate`'s `gunzipSync` and
zip through `unzipSync`, taking the first `.xml` entry. Both are size-capped before they run rather
than after: the gzip trailer's uncompressed size and the zip entry's `originalSize` are checked
against `DMARC_MAX_XML_BYTES`, so an archive that would expand past the cap is never inflated, and
the compressed input itself is capped at `DMARC_MAX_INPUT_BYTES`.

The XML is read by regular expressions over element names rather than by a parser, so no XML
library is bundled for the one document shape this service reads. Elements are matched with their
attributes and whitespace, CDATA sections are unwrapped, comments are dropped, and the five
predefined entities plus numeric character references are decoded. A document is a report only when
it has a `feedback` root, a `report_metadata` with an `org_name`, a `report_id` and a `date_range`,
and a `policy_published` naming a domain; anything else yields null and the attachment is treated
as ordinary. `date_range` is Unix seconds in the wire format and is stored as milliseconds like
every other timestamp. At most `DMARC_MAX_RECORDS` records are read from one report.

`recordDmarcReports` in `src/core/deliverability.ts` writes what it finds after the message row
exists, so `dmarc_reports.message_id` points at the mail the report arrived on. The insert is
`ON CONFLICT (org_name, external_report_id) DO NOTHING ... RETURNING`, so a reporter that sends the
same report twice stores one row and the second delivery inserts no records; the message is still
labelled `dmarc`, because it is one. Like bounce detection, none of this can fail an ingest: the
parse is wrapped, each report is stored inside its own `try`, and a report that cannot be read is
simply mail with an attachment.

Nothing fetches reports. They arrive only if the domain's `_dmarc` record names an address on the
domain in its `rua=` and an inbox exists to receive it; `docs/deploy.md` says what the setup does
and does not do about that.

### Attachment text

Step 9 is followed by `storeAttachmentText` in `src/core/attachments.ts`, which runs
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

`sendMessage`, `replyToMessage` and `forwardMessage` in `src/core/messages.ts` run the same seven
steps:

1. `requireInbox`, which scopes the inbox to the calling principal's account;
2. `assertSendQuota`, which throws `429 quota_exceeded` when the account has already sent
   `QUOTA_MESSAGES_SENT_PER_MONTH` this UTC month, before anything is composed;
3. build through `src/email/outbound.ts`, which normalizes and dedupes recipients, enforces
   `OUTBOUND_MAX_RECIPIENTS`, `OUTBOUND_MAX_ATTACHMENTS` and `OUTBOUND_MAX_BYTES`, and returns both
   a provider-neutral `OutboundMessage` and the derived fields the row needs;
4. reject an unverified account sending anywhere but its own `accounts.email` with
   `403 message_rejected`;
5. `assertRecipientsNotSuppressed`, which fails the whole send with 400 `recipient_suppressed`
   when any recipient is on the account's suppression list under `hard_bounce`, `manual` or
   `provider`;
6. `send`, which picks the transport and normalizes the returned `messageId`;
7. persist one `direction: "outbound"` row labelled `["sent"]` with `raw_key` null, store each
   attachment at `att/{message_id}/{n}`, and call `touchThread`.

All three take an optional `from`. `resolveSender` accepts it only when it normalizes to the
inbox's own address, so an inbox can send as itself or as a subaddress of itself and nothing else;
anything else is `400 invalid_address`. A tag on it makes the From header, the stored `from_addr`
and the `["sent", tag]` labels all carry it, which is what makes the recipient reply to the
subaddressed address and the inbound path label the reply the same way.

The suppression check is one indexed lookup keyed on `(account_id, address)` over the normalized
recipients, and it fails the whole send rather than dropping the bad address, because a partial
send an agent did not ask for is worse than an error it can read. A `soft_bounce` entry does not
block: a full mailbox or a greylisting MTA is a reason to retry later, not a reason to stop. The
operator principal is not exempt, unlike the quotas: suppression protects the domain's reputation
rather than the deployment's budget, and a personal deployment burning its reputation is the case
the check exists for. The Cloudflare send binding keeps a suppression list of its own and raises
`E_RECIPIENT_SUPPRESSED` from it; that is a second, provider-side list we neither read nor write,
and both map onto `recipient_suppressed` so a caller cannot tell which list stopped the send and
does not need to.

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

`src/email/system.ts` holds `sendOtpEmail`, the only mail the service sends on its own behalf. It
builds through `buildSend` and goes out through `send` like every other message, so a deployment on
a non-Cloudflare transport mails its verification codes through that transport too.

### Transports

`MailTransport` in `src/email/transport.ts` is one method, `send(message: OutboundMessage):
Promise<string | null>`, returning the bare RFC message id. `OutboundMessage` is the whole of what a
provider needs — from, to, cc, bcc, reply-to, subject, text, html, headers, attachments as bytes,
and the threading pair — and nothing of how it is sent. `selectTransport(env)` in
`src/email/transports/index.ts` is the only place that reads `MAIL_TRANSPORT`, so adding a provider
is a file plus one branch.

- `cloudflare`, the default, renders the message into an `EmailMessageBuilder` and calls
  `env.EMAIL.send`. It is the only transport that keeps the `E_*` mapping, because it is the only
  one with `E_*` codes.
- `smtp` opens a `cloudflare:sockets` connection, implicit TLS on 465 or `startTls()` after
  `STARTTLS` on 587, authenticates with PLAIN or LOGIN depending on what the EHLO advertises, and
  walks `MAIL FROM`, one `RCPT TO` per recipient, `DATA` dot-stuffed, `QUIT`. The reader is
  line-oriented and folds a multi-line reply into one `{code, lines}`.
- `ses` posts SES v2 `SendEmail` with raw content, signed with SigV4 in `src/lib/sigv4.ts` over
  WebCrypto, so no AWS SDK is bundled.
- `resend` posts its HTTP API with base64 attachments and the headers passed through.

`smtp` and `ses` share `src/email/transports/mime.ts`, which is the serializer the send binding
otherwise hides: folded RFC 5322 headers, RFC 2047 encoded words for non-ASCII, base64 bodies so
nothing depends on line length or 8-bit cleanliness, `multipart/alternative` inside
`multipart/mixed`, and a generated `<ulid@domain>` `Message-ID` when the caller set none. It
returns that id, which is what makes threading work identically on every transport: the id on the
wire is the id stored on the row. `resend` reaches the same place by setting the header itself,
because the id its API returns is its own and not an RFC one.

Every transport maps its provider's rejections onto the same four errors — `sender_not_verified`,
`too_many_requests`, `recipient_suppressed` and `message_rejected` — which is what lets `src/core`
and both adapters stay unaware of which one is configured; `docs/api.md` has the table. A transport
whose secrets are missing raises 503 `sender_not_verified` naming the missing secret at the moment
of the send rather than at startup, because a Worker has no startup to fail in and a half-configured
deployment should still answer every read.

## Webhooks

An account registers https endpoints that receive `message.received`, `message.sent` and
`message.bounced`.
`src/core/webhooks.ts` holds the whole feature and splits into three parts.

**Emit.** `emitEvent(env, accountId, event, inboxId, messageId)` loads the account's active
webhooks that name the event and enqueues one `{webhook_id, event, delivery_id, inbox_id,
message_id}` job per webhook onto `env.WEBHOOKS`, in a single `sendBatch` when there is more than
one. The job carries ids and not the message itself: a queue message body is capped at 128 KB, and
a mail with a large body or an inline image would exceed it and lose the event. `ingestInbound`
calls it once the message row, its attachments and the thread are written, resolving the account
through the inbox row, and calls it again for `message.bounced` first when the message was a
delivery status notification; `persistOutbound` calls it for `message.sent`. It never throws: a
queue that will not take the job is logged and the ingest or the send finishes normally, because a
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

## Deliverability

`src/core/deliverability.ts` answers one question — is this deployment's mail getting through — out
of rows three other subsystems already write. Nothing is recomputed on a schedule and no counter is
kept for it.

`getDeliverability` runs three aggregate queries over a window that defaults to 30 days: `sent` and
`bounced` are `SUM(CASE ...)` over `messages.labels_json` in `src/db/deliverability.ts`, so a send
is a message labelled `sent` and a bounce is the report that came back labelled `bounce`;
`hard_bounces`, `soft_bounces` and `suppressed` come off the `suppressions` table; the DMARC block
is one aggregate over `dmarc_records` joined to `dmarc_reports` plus one grouped query for the top
sources. Rows are never loaded to be counted in JavaScript, so the cost does not grow with the
mailbox.

Scope is one bind parameter, not a second query: the account filter is `(? IS NULL OR ...)`, and
the id is null for the operator and for an org admin, who see the deployment, and the account's own
id for everyone else. `isOrgAdmin` is the same predicate company mode uses. The DMARC figures are
deliberately not scoped: a report says which IP sent as the domain, never which account, so
narrowing them per account would invent a number. `listDmarcReports` and `getDmarcReport` are
admin-only for the same reason in reverse — the records name every sender using the domain.

`warnings` is the part an agent reads first: a bounce rate above `BOUNCE_RATE_WARN`, a DMARC pass
rate below `DMARC_PASS_RATE_WARN`, and a period with no report in it. They are sentences about what
was measured, with the figure and the threshold in them, and they never recommend an action; what
to do about a 40% pass rate depends on facts this service does not have.

## Auth and onboarding

`signup(env, {email, username?}, {ip?})` validates and lowercases the email, looks the account up,
refuses a blocked signup domain and an address outside `ALLOWED_SIGNUP_EMAILS` when that var is set,
calls `RATE.limit({key: ip})` when the adapter passed an ip, then either reuses the account with that
email or inserts one. A new account gets an inbox from `createInbox` and an active key. An existing
account keeps its inboxes and its live keys and gets a **pending** key
(`api_keys.activated_at IS NULL`). Either way an unverified account gets a fresh OTP (`insertOtp`,
hash only; older codes stay until `verify` succeeds so the per-hour cap can count them) and
`sendOtpEmail`; a send failure is reported as `otp_sent: false` rather than failing the call.

`verify` accepts an active or a pending key. With the correct code it activates a pending key,
revokes every other key on the account, and marks the account verified.

`authenticate(env, rawKey)` checks the `OPERATOR_TOKEN` first, then hashes the presented key and
looks it up by hash among the unrevoked, activated rows, loads the account, and returns a
`Principal` (`{account, keyId, pending, scopes}`). It never throws. Every service function takes
that `Principal` and scopes its queries to `principal.account.id`.

### Company mode

`src/core/orgs.ts` holds the whole feature and slots above accounts rather than beside them: every
existing row already hangs off `account_id`, so an inbox joins an org through the account that owns
it and no v1 table changes.

**Bootstrap.** `createOrg` takes the `ADMIN_SECRET` the caller presented, compares it with
`constantTimeEqual` against the secret in `Env`, and refuses when the secret is absent, empty or
shorter than 32 characters, exactly as `OPERATOR_TOKEN` does. It then requires a verified account,
refuses a second org, inserts the org and makes the caller its admin. One org per deployment is a
deliberate limit for now: it keeps `signupInvite` a single lookup and leaves the multi-org routing
question to whoever needs it.

**Roles.** `requireOrg` resolves membership and answers `not_found` for a non-member, so an org is
invisible rather than merely closed; `requireOrgAdmin` adds the role check and answers `forbidden`
for a member, who is inside the org and can see that it refused. The operator principal is treated
as an admin of every org and needs no membership row, which keeps a personal deployment working
without a signup. An admin cannot demote or remove the last admin, so an org always has one.

**Invites.** An invite is a row, not a mail: `signup` is the accept path. `signupInvite` runs
before the rate limit and, once any org exists, refuses an address that has no account and no open
invite as `signup_closed`. The account lookup happens first and is passed in, because an address
that already has an account must keep the repeat-signup path: that path mints a pending key and
changes nothing until `verify` exchanges the emailed code, so gating it on an invite would only
break lost-key recovery for a member. `ALLOWED_SIGNUP_EMAILS` still runs whenever no invite was
found, so the zero-org case is v1 exactly. Accepting inserts the membership, stamps `accepted_at` and audits `member.joined`,
for a new account and for an existing one that was invited later. Reusing signup means one OTP
path, one rate limiter and one lost-key story rather than a second onboarding flow.

**Provisioning.** `provisionInbox` builds a `Principal` for the target member and calls the same
`createInbox`, so the quota, the reserved usernames and the domain check are the member's own and
an admin cannot mint inboxes past `INBOX_LIMIT` for someone else.

**Audit.** `src/core/audit.ts` is the only writer. `recordAudit` takes an explicit org;
`recordAccountAudit` resolves the account's membership and writes nothing when it has none, which
is what keeps a zero-org deployment free of audit rows. It is append-only by construction: no
update or delete helper exists, and `src/db/audit.ts` offers only an insert and a keyset list.
Removing a member leaves their rows behind, which is the point of a log.

### OAuth for MCP clients

`src/core/oauth.ts` holds the flow, `src/http/routes/oauth.ts` the six routes and
`src/http/oauth-pages.ts` the two forms and the error page. It exists because an MCP client that
cannot be given a static header has no way to hold an `it_` key, and the MCP authorization
specification says how such a client asks for one: read `/.well-known/oauth-protected-resource`,
read `/.well-known/oauth-authorization-server`, register itself, send the user to the authorize
page, exchange the code.

**The token is an `api_keys` row.** That is the whole design. `exchangeToken` mints through the
same path `createApiKey` uses, so an OAuth token is listed by `GET /v1/api-keys`, revoked by
`DELETE /v1/api-keys/:key_id`, carries `scopes` and `activated_at` like any other key, and needs no
second code path in `authenticate`. A token store, an expiry, a refresh grant and a revocation
endpoint are all things the key table already answers.

**Authentication is the existing OTP.** The authorize page asks for the account's email and sends
the same six-digit code `signup` sends, under the same per-account hourly cap, and `consumeOtp` in
`src/core/accounts.ts` is shared with `verify` so the expiry, the attempt count and the
mark-as-verified are one implementation. Proving control of the address is exactly what `verify`
proves, so a correct code here verifies the account too. There are no passwords and no sessions
beyond the ten-minute row that carries the in-progress authorization.

**Three tables, all short-lived but two of them.** `oauth_clients` is permanent, one row per
registered client. `oauth_sessions` is the authorization in progress: client, redirect URI, state,
challenge, and the account once the email step passes, expiring in 10 minutes. `oauth_codes` holds
the hash of the authorization code alone, expiring in 60 seconds and single use, bound to the
client, the redirect URI and the challenge so a stolen code is useless without the verifier. Both
short-lived tables are pruned with one `DELETE ... WHERE expires_at < ?` on each authorize and each
token call, so no cron is needed and an abandoned authorization costs one row until the next
caller.

**Public clients only, so PKCE carries the security.** There is no client secret to protect, and
`code_challenge_methods_supported` is `S256` alone. An unknown `client_id` or an unregistered
`redirect_uri` renders an error page instead of redirecting, so the endpoint cannot be turned into
an open redirector; every later failure redirects with `error` as RFC 6749 requires, because by
then the redirect URI is known to belong to the client.

`/mcp` answers 401 with `WWW-Authenticate: Bearer resource_metadata="..."` for an `Authorization`
header that resolves to nothing, which is what makes a client discover the flow and what makes a
revoked token restart it. A pending key still gets the onboarding tool set, since calling `verify`
is the only thing a pending key is for, and a request with no header at all keeps the
unauthenticated tool set that `docs/api.md` promises.

## MCP

`handleMcp` reads the key from `Authorization: Bearer` or `X-API-Key` and runs `authenticate`
before it builds a fresh `McpServer` for the request through `createMcpHandler`. Which tool set is
registered depends on the result: three onboarding tools without a live key, fifty-five with one.
Server instructions differ by auth state, and an operator connection gets a note saying no signup
is needed. Tools call the same `src/core` functions the HTTP routes call and return JSON in a
single text block.

## Schemas and the OpenAPI document

`src/schemas/` is the one place a request or a response shape is written down: one module per
resource for the inputs the MCP tools validate with, and `objects.ts` for the response objects,
which mirror `src/core/serialize.ts` field for field. Nothing in it imports an adapter, so both
adapters and the document can depend on it. Each MCP tool passes a schema from there as its
`inputSchema` rather than building one inline, and each REST body, query and path parameter in the
document is the same schema with the fields that surface carries: `send_message_body` keeps
`headers`, which MCP has no argument for, and the MCP input adds the `inbox_id` the REST path
already names.

`src/http/openapi.ts` turns a declarative route table — method, path, summary, the schemas for path
params, query, headers, body and response, the success status, and which errors apply — into an
OpenAPI 3.1 document. Headers are in the table for `POST /v1/orgs` alone, which takes its
`x-admin-secret` in a header rather than the body. zod 4's `z.toJSONSchema` does the conversion, so no generator is bundled: the response
objects and request bodies go into a `z.registry` and one call over the registry emits
`components.schemas` with `$ref`s between them, while parameters are converted one object at a time
and split into OpenAPI parameter objects. `servers` is `PUBLIC_URL`, so the document is built once
per isolate and cached under that key, and `GET /openapi.json` in `src/http/routes/openapi.ts`
serves the cached string unauthenticated.

`test/openapi.test.ts` walks `app.routes`, drops the `ALL` entries the auth middleware registers,
rewrites Hono's `:param` to `{param}` and asserts that set equals the set of operations in the
document, in both directions. That is what keeps the document honest: a route added without a table
entry, or a table entry for a route that was removed, fails the suite. `test/schemas.test.ts` is
the other half — it serializes a real row of each kind and parses it against its schema, and the
schemas are strict, so a field added to `serialize.ts` and not to `objects.ts` fails too.

## Data model

One D1 database. `0001_init.sql` is the released baseline and every later change is its own
numbered migration.

| Table | Key | Notes |
| --- | --- | --- |
| `accounts` | `id` (`acc_`) | unique `email`, `verified_at` null until the OTP is exchanged |
| `api_keys` | `id` (`key_`) | unique `key_hash`, `scopes_json` (`["*"]` in v1), `activated_at`, `revoked_at` |
| `otps` | `account_id` | `code_hash`, `expires_at`, `attempts`; codes are never stored in the clear |
| `inboxes` | `inbox_id` (the address) | `username` and `domain` denormalized, `display_name`, `routing_rule_id` null in `catch_all` mode |
| `threads` | `thread_id` (`thr_`) | `subject`, `last_message_at`, `message_count`, `participants_json` |
| `messages` | `message_id` (`msg_`) | `direction`, RFC identifiers, address columns, bodies, `labels_json`, `raw_key`, `spam_score`, `spam_reasons_json` |
| `attachments` | `attachment_id` (`att_`) | `r2_key`, `filename`, `content_type`, `size`, `inline`, `content_id`, `text`, `text_status` |
| `drafts` | `draft_id` (`drf_`) | `kind`, `parent_message_id`, `body_json` (attachment metadata only, bytes in R2), `send_at`, `status`, `sent_message_id`, `error`; indexed on `(inbox_id, updated_at)` and `(status, send_at)` |
| `usage` | `(account_id, period)` | `period` is a `YYYY-MM` UTC month or the literal `all`; `messages_sent`, `messages_received`, `storage_bytes` |
| `dmarc_reports` | `report_id` (`dmr_`) | `domain`, `org_name`, `org_email`, `external_report_id` unique with `org_name`, `begin_at`, `end_at`, `policy_json`, `message_id` of the mail it arrived on; indexed on `(domain, end_at)` |
| `dmarc_records` | `record_id` (`dmc_`) | `report_id` cascading from `dmarc_reports`, `source_ip`, `count`, `disposition`, `dkim`, `spf`, `header_from`, `envelope_from`, `auth_json`; indexed on `report_id` |
| `suppressions` | `(account_id, address)` | `reason` (`hard_bounce`, `soft_bounce`, `manual`, `provider`), `source` (`dsn`, `api`, `provider`), `detail`, `message_id` of the bounce report, `created_at`, `last_seen_at`; indexed on `(account_id, created_at)` |
| `webhooks` | `webhook_id` (`whk_`) | `account_id`, `url`, `secret`, `events_json`, `description`, `active` |
| `domains` | `domain` (the name) | `account_id`, `zone_id`, `sending_tag`, `status` (`pending`, `verified`, `failed`), `records_json`, `error`, `verified_at`; indexed on `(account_id, created_at)` |
| `orgs` | `org_id` (`org_`) | `name`; one row per deployment for now |
| `memberships` | `(org_id, account_id)` | `role` (`admin` or `member`), indexed on `account_id` |
| `invites` | `invite_id` (`inv_`) | `org_id`, `email`, `role`, `invited_by`, `accepted_at` null while open; indexed on `(org_id, email)` |
| `oauth_clients` | `client_id` (`oac_`) | `name`, `redirect_uris_json`; one row per registered MCP client, permanent |
| `oauth_sessions` | `session_id` (`oas_`) | `client_id`, `redirect_uri`, `state`, `code_challenge`, `scope`, `account_id` null until the email step passes, `expires_at` 10 minutes out |
| `oauth_codes` | `code_hash` | `session_id`, `client_id`, `account_id`, `redirect_uri`, `code_challenge`, `expires_at` 60 seconds out, `used_at` null until redeemed; the code itself is never stored |
| `audit_log` | `audit_id` (`aud_`) | `org_id`, `account_id`, `action`, `target`; indexed on `(org_id, created_at)`, append-only, and `account_id` carries no foreign key so a row outlives the account |
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

**D1 for metadata, R2 for bytes; the one Durable Object per inbox holds no state.** Cross-inbox
queries, filters and pagination stay plain SQL and rows stay small, because no message, thread or
counter lives in an actor. `InboxWaiter` is the single exception and it persists nothing: in memory
it holds the `wait_for_message` calls parked on that inbox right now and the newest `created_at` it
has been notified about, so losing an instance costs a wake-up rather than data, and a deployment
without the binding still works.

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
`drf_`, `whk_`, `org_`, `inv_`, `aud_`, `dmr_`, `dmc_`).
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

**Onboarding is an emailed OTP, and there is no dashboard, with one exception.** The exception is
`GET /oauth/authorize`, the page that asks an account holder for their address and then for the
emailed code. It exists because the OAuth authorization step is defined as a browser redirect to a
page the user sees; a client cannot complete the flow against JSON. It is deliberately the whole of
the human-facing surface: two forms and an error page, rendered by template functions in
`src/http/oauth-pages.ts` that escape every value they interpolate. It carries no JavaScript, no
external asset and no state beyond a hidden session id, so there is no build step, no bundle to
keep current, and nothing on the page that a stranger's registered client name could turn into
script. Everything else stays API-only.

**Onboarding is an emailed OTP, and there is no dashboard.** An agent gets a working key and an
inbox from one unauthenticated `POST /v1/agent/signup`, and only outbound reach is gated: until the
account exchanges the six-digit code it may email its own signup address alone. Proving control of
the address is what unlocks sending, so a fabricated address gains nothing. The guards are a
10-minute OTP expiry, 5 attempts, at most 3 codes per hour per address, per-IP rate limiting on
signup, a reserved-username list, and `INBOX_LIMIT` per account.

**A repeat signup mints a pending key rather than revoking anything.** A pending key authenticates
nowhere except `verify`, so an attacker who knows the address cannot take an account over, and the
owner who lost a key can still get back in by reading the emailed code. An org does not close that
path: an invite gates a new account, not an existing one.

**An API key's scopes are `*` alone or a list of inboxes.** `normalizeScopes` refuses a list that
holds `*` alongside an `inbox:` entry, so a key's reach never depends on which check reads the list
first.

**An API key's scopes are enforced in core, once.** `Principal` carries `scopes`, `authenticate`
fills it from `api_keys.scopes_json`, and the check lives where the inbox is resolved:
`requireInbox` in `src/core/inboxes.ts` answers `not_found` for an inbox outside the scope, so
every message, thread, draft and attachment operation inherits it from the one call they all
already make, and an out-of-scope inbox is indistinguishable from one that does not exist.
Account-level functions call `requireFullScope` instead and answer `forbidden`, and `listInboxes`
passes the scope list down as a SQL filter so a page is still a page. Enforcing it in the adapters
would mean writing the same check twice and letting the two surfaces drift, which is the same
reason the adapters hold no other logic.

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
for up to 55 seconds and returns the first matching message or an empty result. A webhook is for
the deployment that does have somewhere to receive a push, and it costs the reading path nothing.

**The wait is pushed by the ingest, and polling is the fallback.** `src/waiter.ts` defines
`InboxWaiter`, a Durable Object reached with `idFromName(inbox_id)`, whose `wait(timeoutMs, since)`
resolves `true` on a notify and `false` on the timeout, and whose `notify(createdAt)` resolves every
waiter parked on that inbox. `ingestInbound` calls `notify` once the message row is committed,
after the webhook event and best-effort: a namespace that is missing or an RPC that throws is
swallowed, because a wake-up is never worth failing an ingest for. A `wait` queries D1 once, parks
on the object for the time it has left, then queries D1 a second time; the second query covers a
notify that arrives after the park ends for any other reason. Without the binding, or when the RPC
throws, the call falls back to polling D1 every 2 seconds and behaves exactly as before. The queue
and cron paths do not notify, because a message the caller sent itself is not what `wait` is
waiting for.

**The object remembers the newest `created_at` it was told about, so a notify cannot be missed
between the query and the registration.** `notify` keeps the maximum `created_at` it has seen and
`wait` resolves `true` at once, parking nothing, when that value is greater than the caller's
`since`. Without it a notify landing after the first D1 query and before the wait is registered
would leave the call asleep for the whole remaining timeout, up to 55 seconds, which is the latency
the object exists to remove; the result was correct only because of the second query. The memory
lives in the instance and is lost when the object is evicted, which is harmless: an evicted object
has no parked waiters either, and the second D1 query still runs.
