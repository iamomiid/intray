# Status

What is built, and what a contributor needs to know before touching it. Design rationale lives in
`docs/architecture.md`; planned work lives in `ROADMAP.md`.

## Subsystems

| Subsystem | Status | Notes |
| --- | --- | --- |
| scaffold | done | pnpm, `wrangler.jsonc`, tsconfig, biome with the `lint/no-let.grit` plugin, vitest-in-workerd |
| ci | done | `.github/workflows/ci.yml` on pull requests and `main`: lint, typecheck, tests, forbidden-identifier check, gitleaks |
| db | done | one module per table plus `rows.ts` and `index.ts`; keyset pagination |
| lib | done | `address`, `hash`, `otp`, `pagination`, `limits`, `time`, `rfc`, `errors`, `ids`, `sigv4` |
| accounts, keys, OTP | done | signup, verify, me, authenticate, key create/list/revoke; pending keys for repeat signup; `ALLOWED_SIGNUP_EMAILS` |
| operator token | done | `src/core/operator.ts`; `OPERATOR_TOKEN` resolves to `acc_operator`, checked before the key-hash lookup |
| inboxes | done | create, get, list, delete with R2 cleanup, plus `requireInbox` |
| inbound | done | `src/email/{inbound,threading,parse}.ts`; `email()` stores to D1 and R2 |
| routing | done | `src/core/routing.ts`, `src/lib/cloudflare.ts`, `migrations/0008_routing.sql`; `ROUTING_MODE` is `catch_all` by default, `per_inbox` gives every inbox its own Email Routing rule created before the row and removed before the row, the setup's Routing steps write the vars, the `ROUTING_API_TOKEN` secret and reconcile the zone's rules against the deployment's inboxes |
| transports | done | `src/email/transport.ts`, `src/email/transports/`; `MAIL_TRANSPORT` picks `cloudflare`, the default, `smtp` over `cloudflare:sockets`, `ses` over SigV4-signed SES v2, or `resend` over its HTTP API, all behind one `MailTransport.send(OutboundMessage)`; `transports/mime.ts` serializes RFC 5322 for `smtp` and `ses` and `src/lib/sigv4.ts` signs for `ses`; every transport maps its rejections onto the same four errors, so `src/core` and both adapters are unchanged |
| inbound over http | done | `src/core/inbound.ts`, `src/http/routes/inbound.ts`, `src/email/notifications.ts`; `POST /v1/inbound` takes raw MIME or JSON from any provider through the same `ingestInbound`, and `POST /v1/inbound/bounces` takes SES-over-SNS, Resend and generic bounce notifications onto the suppression list, both behind `INBOUND_SECRET` |
| outbound | done | recipient normalization, send/reply/forward builders producing an `OutboundMessage`, limit checks, the pre-send suppression check, send-error mapping |
| core services | done | `serialize`, `principal`, `accounts`, `keys`, `inboxes`, `threads`, `messages`, `attachments`, `suppressions`, `orgs`, `audit`, `oauth` |
| http | done | `types.ts`, `auth.ts`, `body.ts`, one router per resource; every `/v1` endpoint in `docs/api.md` |
| schemas | done | `src/schemas/`, one module per resource plus `objects.ts`; the MCP tools' `inputSchema` and the OpenAPI document both read from it, and `test/schemas.test.ts` parses a serialized row of each kind against its schema |
| openapi | done | `GET /openapi.json`, built in `src/http/openapi.ts` from a route table and `z.toJSONSchema`, served by `src/http/routes/openapi.ts`; `test/openapi.test.ts` compares the document against `app.routes` in both directions |
| mcp | done | `src/mcp/{server,tools,result}.ts`; 3 onboarding tools without a live key, 55 with one, and 401 with a `WWW-Authenticate` resource pointer for a key that resolves to nothing |
| setup | done | `pnpm run login` then `pnpm run setup`; apex and subdomain modes, consent prompts, idempotent steps |
| subaddressing | done | `splitTag` and `tagLabel` in `src/lib/address.ts`; inbound tags become labels, `from` on send/reply/forward may be subaddressed |
| batch operations | done | message label and delete batches, thread label update and delete; one `db.batch` per request, R2 cleanup and thread recount in `src/core/{messages,threads}.ts` |
| message search | done | `searchMessages` runs against the `messages_fts` FTS5 table, ranked by `bm25` with the subject weighted above the body; the `from`/`to`/`subject` filters on `list_messages` stay `LIKE` scans and are fine at v1 volumes |
| drafts | done | `src/core/drafts.ts`, `migrations/0004_drafts.sql`; create, list, get, update, delete, send now, and a one-minute cron trigger draining due scheduled drafts through `sendMessage` and `replyToMessage` |
| orgs | done | `src/core/orgs.ts`, `src/core/audit.ts`, `migrations/0006_company.sql`; `ADMIN_SECRET` bootstraps one org, invites are accepted through signup, admins provision inboxes to members, API keys take `inbox:` scopes enforced in core, and an append-only audit log covers the admin actions |
| suppressions | done | `src/core/suppressions.ts`, `src/email/bounce.ts`, `migrations/0010_suppressions.sql`; delivery status notifications arriving on an inbox are labelled `bounce` and write a per-account suppression row, `GET/POST /v1/suppressions` and `DELETE /v1/suppressions/:address` read and edit the list, and `sendMessage`, `replyToMessage` and `forwardMessage` fail 400 `recipient_suppressed` before the send |
| domains | done | `src/core/domains.ts`, `src/db/domains.ts`, `migrations/0012_domains.sql`; an account registers a domain that is a zone in the deployment's Cloudflare account or a subdomain of one, `addDomain` onboards it for sending, enables Email Routing and writes the missing DNS, `verifyDomain` polls and retries, and an inbox on a verified domain always gets its own routing rule on that domain's zone |
| webhooks | done | `src/core/webhooks.ts`; per-account https endpoints for `message.received`, `message.sent` and `message.bounced`, HMAC-SHA256 signed, delivered and retried through the `intray-webhooks` queue |
| wait | done | `src/waiter.ts`; `InboxWaiter` is a Durable Object per inbox holding parked `wait` calls and no storage, notified by `ingestInbound` after the row is committed, with the 2-second D1 poll kept as the fallback when `INBOX_WAITER` is unbound or the RPC throws |
| usage | done | `src/core/usage.ts`, `src/db/usage.ts`, `migrations/0007_usage.sql`; upsert counters for messages sent, messages received and stored bytes, read through `GET /v1/usage` or `get_usage`, enforced as `QUOTA_MESSAGES_SENT_PER_MONTH`, `QUOTA_MESSAGES_RECEIVED_PER_MONTH` and `QUOTA_STORAGE_BYTES` |
| oauth | done | `src/core/oauth.ts`, `src/http/routes/oauth.ts`, `src/http/oauth-pages.ts`, `migrations/0009_oauth.sql`; RFC 8414 and RFC 9728 metadata, RFC 7591 registration, an authorization-code flow with PKCE behind the existing OTP, and tokens that are ordinary `api_keys` rows |
| spam | done | `src/email/spam.ts`, `migrations/0011_spam.sql`; every inbound message is scored from headers, identity, subject, body, list and attachment signals, labelled `spam` at `SPAM_LABEL_THRESHOLD`, refused at `SPAM_REJECT_THRESHOLD`, refused outright for an executable attachment and scored but not refused for a script attachment; `spam_score` and `spam_reasons` ride on every message object and `max_spam_score` filters a list |
| deliverability | done | `src/core/deliverability.ts`, `src/email/dmarc.ts`, `src/db/{deliverability,dmarc}.ts`, `migrations/0013_dmarc.sql`; DMARC aggregate reports arriving as mail are decompressed, parsed and stored on ingest and the message is labelled `dmarc`, and `GET /v1/deliverability`, `GET /v1/dmarc-reports` and `GET /v1/dmarc-reports/:report_id` read them back beside the send, bounce and suppression counts |
| attachments | partial | `core.listAttachments` has no HTTP route; attachments are embedded on message objects and downloaded one at a time. Text is extracted from PDF and docx on ingest into `attachments.text`, read through `GET .../attachments/:attachment_id/text` or `get_attachment`; `text_status` rides on every attachment object |

## Limitations

- Subaddressed delivery under a `literal` rule is unverified: nobody has confirmed on a live zone
  that a rule for `desk-agent@` also delivers `desk-agent+invoices@`. Until someone does,
  subaddressing works only in `catch_all` mode, where the catch-all matches every local part.
  Verify it before moving a deployment that relies on tags.
- Email Routing rules are capped per zone, so `per_inbox` mode bounds the total number of inboxes
  across every account on the deployment, not just per account. Past the cap `createInbox` answers
  409 `conflict` with `inbox limit reached`.
- In `per_inbox` mode `createInbox` and `deleteInbox` each make a Cloudflare API call, so both are
  slower than a D1 write and both fail with 503 `routing_unavailable` while the API is unreachable.
  Nothing retries; the setup's reconcile is what repairs a create that got the rule but not the row
  or the other way round.
- A custom domain must be a zone in the deployment's Cloudflare account, or a subdomain of one. A
  domain the account does not hold in Cloudflare is 400 `bad_request`; there is no flow for a zone
  hosted elsewhere, because every step of onboarding is a zone-level write.
- Removing a custom domain requires that no inbox is on it. `DELETE /v1/domains/:domain` answers
  409 `conflict` rather than cascading, so the inboxes and their mail are never deleted by a domain
  call.
- DNS propagation is the zone's business. `addDomain` writes the records and `verifyDomain` reports
  what Cloudflare currently sees; neither waits, so a domain can sit `pending` for as long as the
  zone takes and an agent has to poll `verify_domain`.
- Every `/v1/domains` call reaches the Cloudflare API, so all of them fail 503
  `routing_unavailable` while it is unreachable or `ROUTING_API_TOKEN` is unset, and the token has
  to be scoped to all zones in the account rather than to one.
- OAuth issues no refresh token and the access token does not expire. It is an `api_keys` row, so
  ending a connection means revoking the key through `DELETE /v1/api-keys/:key_id`; a client that
  loses its token runs the flow again.
- OAuth clients are public clients only. There is no client secret, no `client_credentials` grant
  and no registration access token, so a registered client cannot update or delete its own
  registration and `oauth_clients` rows are never cleaned up.
- An OAuth token is always scoped `*`. The `scope` parameter is recorded on the authorization and
  otherwise unused, so a client cannot ask for a key limited to one inbox.
- One org per deployment. `POST /v1/orgs` answers `conflict` once an org exists, and `signupInvite`
  looks the invite up in that single org, so a deployment cannot host two companies.
- Removing a member drops the membership and revokes their keys but keeps their inboxes, threads
  and messages. An admin who wants the mail gone deletes the inboxes, and nothing reassigns them to
  another account.
- An invite is a row rather than a mail: nothing is sent when it is created, and the invited
  address learns of it out of band. The OTP it gets is the ordinary signup one.
- A webhook secret is stored in the clear, because HMAC needs the original bytes. Anyone who can
  read the D1 database can forge a delivery to that subscriber; nothing else on the account is
  reachable with it.
- Webhook delivery is at-least-once and unordered, and a delivery still failing after 5 retries is
  dropped with no record. There is no delivery log and no way to replay one.
- Storage is counted from `0007_usage.sql` forward. Messages and attachments stored before the
  migration are not in `storage_bytes` and are not backfilled, so an existing deployment reads low
  until a backfill sums `messages.size` and `attachments.size` per account into the `all` row.
  Deleting a pre-migration message decrements nothing below zero, because the counter is clamped.
- Usage is per account. There is no per-org rollup, because there are no orgs yet; once there are,
  a rollup is a `GROUP BY` over the member accounts' rows for a period.
- Only DSN-shaped bounces are recognized: a `multipart/report; report-type=delivery-status`
  message, or a `text/plain` one from `mailer-daemon@` or `postmaster@` with `Auto-Submitted:
  auto-replied` and DSN field lines in its body. A provider that returns prose with no
  `Final-Recipient`, `Action` and `Status` fields is stored as an ordinary message and suppresses
  nothing, so the list under-reports rather than over-blocks. The shape Cloudflare's own bounce mail
  arrives in has not been verified against a live zone.
- The suppression list is fed by bounce mail that reaches an inbox on this deployment, by
  `POST /v1/suppressions`, and by `POST /v1/inbound/bounces`, which writes the `provider` reason
  and source. Nothing reads a provider's own suppression list, so an address a provider is already
  refusing is only learned about when it tells us.
- No transport has been exercised against a real provider. `smtp`, `ses` and `resend` are covered
  by unit tests against a scripted socket and a stubbed `fetch`, which prove the command sequence,
  the signature and the error mapping but not that a real server accepts the bytes. Verify one
  provider end to end before a deployment depends on it, and expect the first find to be in the
  MIME the serializer produces rather than in the protocol around it.
- Neither inbound endpoint verifies a provider signature: no SNS `SigningCertURL` check, no Resend
  `svix` header check. `INBOUND_SECRET` is the whole of the authentication, so anyone holding it
  can inject mail into any inbox on the deployment and suppress any address on the account that
  owns the named sending inbox. An SNS `SubscriptionConfirmation` is confirmed by fetching whatever
  `SubscribeURL` it carries, which is a request the caller chooses; nothing else is done with the
  response.
- `POST /v1/inbound` is not rate limited by `RATE`, so a leaked `INBOUND_SECRET` is bounded only by
  the account quotas the ingest already enforces.
- A transport other than `cloudflare` still expects the mail domain to be a zone in the logged-in
  Cloudflare account, because the setup's Zone step and the routing steps are unchanged; only the
  Email Routing and Email Sending steps are skipped.
- SPF, DKIM and DMARC for a non-Cloudflare transport are the provider's business and nothing in the
  Worker checks them. The `smtp` transport in particular signs nothing: whatever the submission
  server does is what arrives.
- The send binding keeps its own suppression list, which is not readable and not synchronized with
  this one. A send that passes our check can still come back `recipient_suppressed` from the
  binding, and releasing an address here does not release it there.
- Outbound bounces never reach an inbox on the Cloudflare transport, so `bounced`, `hard_bounces`
  and `soft_bounces` read 0 on a live deployment however much mail fails. Mail sent through the
  send binding carries a return path on `cf-bounce.<domain>`, whose MX points at Cloudflare rather
  than at this Worker, so the DSN goes to Cloudflare and is never delivered here for
  `detectBounce` to read. Cloudflare keeps its own account-level suppression list from those
  bounces, readable at `GET /accounts/{account}/email/sending/suppressions`; mirroring it into the
  `suppressions` table is planned work and is not implemented. Until it is, the bounce half of the
  deliverability summary counts DSN mail an inbox actually receives plus whatever a provider posts
  to `POST /v1/inbound/bounces`, which is the path an `smtp`, `ses` or `resend` deployment uses and
  the Cloudflare transport has no equivalent of.
- DMARC visibility is aggregate reports only. Forensic (`ruf`) reports are not parsed and nothing
  sends them anyway on most receivers, and an aggregate report is a day behind and rounds to whole
  messages, so it says how the domain is authenticated overall and never why one message failed.
- Nothing fetches DMARC reports. They are stored only when a report arrives as mail to an inbox
  this deployment serves, which needs a `rua=` on the domain's `_dmarc` record pointing at such an
  address; `--dmarc-reports` does not arrange that, it turns on Cloudflare's own collection into
  the dashboard. A deployment without that record reads `reports: 0` and gets the matching warning.
- The deliverability summary is descriptive. `warnings` names a bounce rate above 5%, a DMARC pass
  rate below 95% and a period with no report in it, with the measured figure and the threshold in
  the sentence, and stops there: it never recommends an action, because what to do about a low pass
  rate depends on the domain's DNS and sending history rather than on anything this service holds.
- The DMARC figures are domain-level and are the same for every caller, including a plain account
  reading its own summary. A report names the sending IP, never the account, so the block cannot be
  narrowed; only `sent`, `bounced` and the suppression counts are scoped to the caller.
- Nothing ages `dmarc_reports` out. Reports accumulate one row per reporter per day plus a record
  per sending address, and only an inbox, thread or message delete removes the mail they arrived
  on, never the parsed rows.
- Nothing ages entries out of `suppressions`. A `soft_bounce` row stays until an agent deletes it,
  and `last_seen_at` is recorded so a later policy can expire on it without another migration.
- Nothing expires R2 raw MIME objects. They are removed only by the explicit inbox, thread and
  message delete paths, so a busy deployment grows without bound.
- Spam scoring is heuristics over one message. There is no reputation data, no corpus, no training
  and no memory of the sender, so a first message from a legitimate sender with a thin html body
  and a link scores the same as a mailshot with the same shape. The weights in `src/email/spam.ts`
  are a starting point an operator is expected to tune through the two thresholds.
- There is no antivirus engine and there cannot be one in a Worker. Attachment screening is by
  extension, by double extension, by Office content type, and by the names inside a zip; a
  renamed executable, a macro in a document that was not named `docm`, and anything inside an
  archive that is not a zip pass through. A zip is listed, never decompressed, so nothing nested
  deeper than one level is seen.
- Script attachments are scored, not refused: `js`, `jse`, `wsf`, `sh`, `py`, `rb` and `pl` add
  `attachment_script` at 30 whether they arrive loose or in a zip, so a zip of source code is
  stored. Only the executable list refuses, and a deployment that wants scripts kept out has to
  edit `EXECUTABLE_EXTENSIONS`; there is no var for it.
- `spam_score` and `spam_reasons` are written once on ingest and never recomputed. Changing the
  weights or a threshold moves what happens to new mail and leaves stored rows as they were.
- Threading has no subject-based fallback. A reply from a client that drops both `In-Reply-To` and
  `References` starts a new thread.
- `reply_all` puts every merged recipient in `To` and never in `Cc`, and a forward re-sends the
  parent's inline attachments as ordinary attachments. Both are simplifications.
- `GET /oauth/authorize` is the one human-facing page the service serves, and it is deliberately
  plain: no JavaScript, no external assets, no styling beyond a few inline rules. It is not a
  dashboard and nothing else should grow onto it.
- `signup` over MCP has no client IP, so it passes an empty `SignupContext` and skips the per-IP
  rate limiter. Only the per-account hourly OTP cap applies on that path.
- `0001_init.sql` is the released baseline and is never edited. Every schema change is a new
  numbered migration under `migrations/`, applied with `pnpm db:migrate:local` and
  `pnpm db:migrate:remote`.
- Search pages by offset, not by key, because relevance order is not a sort key. A page taken while
  new mail is arriving can therefore shift under the reader; `list_messages` is unaffected.
- The `messages_fts` triggers key on `message_id`, which no virtual table can index, so deleting a
  message scans the FTS content table. The alternative, keying on `messages.rowid`, is unsafe: with
  a TEXT primary key that rowid can be renumbered.
- `/openapi.json` describes the REST surface only. The MCP tools validate with the same schemas but
  are not in the document, because there is no MCP equivalent of an OpenAPI operation.
- Response objects in `src/schemas/objects.ts` are strict, so the document carries
  `additionalProperties: false` on them. That is what makes the drift test catch a field added to
  `serialize.ts` alone, and it means a client generated from the document rejects a response
  carrying a field its copy of the schema predates. Regenerate the client when the contract moves.

## Gotchas

- `SELF.scheduled()` fails in the vitest pool with `DataCloneError: Could not serialize object of
  type "LoopbackServiceStub"`. A test that needs the cron path imports the default export from
  `src/index.ts` and calls `worker.scheduled?.(controller, env)` with a plain object cast to
  `ScheduledController`; the handler takes no `ExecutionContext`, so passing one is a type error.
- A draft left in `sending` is never picked up again by the drain, by design. A test that seeds one
  to assert the `conflict` paths must not expect a later drain to clear it.

- `@cloudflare/vitest-pool-workers` bundles a workerd that supports compatibility dates only up to
  2026-08-22, while `wrangler.jsonc` declares a later one. `vitest.config.ts` overrides
  `miniflare.compatibilityDate` to 2026-08-22 for tests. Remove that override once the pool ships a
  newer runtime, and re-check that nothing depends on behavior gated between the two dates.
- The `smtp` transport is tested against a scripted fake socket: `smtpTransport(settings, connect)`
  takes the `cloudflare:sockets` `connect` as a parameter defaulting to the real one, and the suite
  passes a socket whose `readable` replays one reply per read and whose `writable` records the
  commands. Nothing in the suite opens a socket, and a test that adds a recipient has to add a
  `250` for its `RCPT TO` or the replies shift and the failure looks like a `DATA` rejection.
- Suites that assert on an outbound message pass their own transport through `{...env, MAIL: fake}`
  and read the `OutboundMessage`; `test/support.ts` has `fakeTransport()` for it. The `EMAIL` fakes
  are still valid and still used, because `cloudflare` is the transport the suite pins.
- Tests set `remoteBindings: false` because the `send_email` binding is declared `remote: true`,
  which would otherwise make vitest open an authenticated remote proxy session. The local stand-in
  accepts `send(EmailMessageBuilder)`, logs the message, writes the bodies to a temp file, and
  resolves to a random `messageId`, so a send can be called in tests; nothing leaves the machine,
  and delivery itself still needs `wrangler dev` and real credentials. Suites that assert on what
  was sent pass their own `EMAIL` fake through `{...env, EMAIL: fake}`.
- D1 binds at most 100 parameters per statement, and local SQLite in the vitest pool does not
  enforce it, so a statement that overflows the cap passes the suite and fails in production with
  "too many SQL variables". List arguments therefore go through `json_each` on a single JSON
  parameter, `WHERE id IN (SELECT value FROM json_each(?))` bound with `JSON.stringify(ids)`, rather
  than a spliced `IN (?, ?, ...)`.
- The Durable Object needs nothing extra from the vitest pool: the binding and the `migrations`
  entry in `wrangler.jsonc` are enough, and `runInDurableObject` from `cloudflare:test` reaches the
  instance. Two things bite. `DurableObjectStub<T>` does not infer the callback's instance type, so
  the call needs explicit type arguments, `runInDurableObject<InboxWaiter, boolean>(stub, ...)`. And
  `resetDatabase` clears D1 only: an object's in-memory waiters survive into the next test in the
  file, so a suite that parks a wait asserts it is gone before moving on.
- A test that writes a message row straight into D1 does not notify the waiter, so a `wait` parked
  on the object sleeps until its timeout instead of returning. Drive the push path with
  `ingestInbound`, and reserve the direct insert for the polling fallback, which the two fallback
  tests exercise with `{...env, INBOX_WAITER: undefined}` and with a namespace whose `wait` rejects.
- The pool does not roll D1 back between tests in a file, so writes leak from one test to the next.
  `test/support.ts` exports `resetDatabase(db)`; call it in `beforeEach` of any suite that writes.
  It does not clean up R2 objects.
- `vitest.config.ts` pins `MAIL_DOMAINS`, `INBOX_LIMIT`, `PUBLIC_URL`, `ALLOWED_SIGNUP_EMAILS`, the
  three `QUOTA_*` vars, both `SPAM_*` thresholds, `ROUTING_MODE`, `MAIL_TRANSPORT`,
  `CLOUDFLARE_ZONE_ID`,
  `WORKER_NAME`, `OPERATOR_TOKEN`, `ADMIN_SECRET` and
  `INBOUND_SECRET` in the miniflare bindings, so changing the deployment vars in `wrangler.jsonc`
  cannot move the suite. `test/spam.test.ts` asserts exact scores against the pinned
  `SPAM_LABEL_THRESHOLD` of 50 and `SPAM_REJECT_THRESHOLD` of 90, and the suites that need other
  thresholds pass `{...env, SPAM_REJECT_THRESHOLD: "0"}` per test rather than moving the pins. HTTP and MCP suites must use the operator-token constant from
  `test/support.ts`, because `SELF.fetch` takes no per-request env override.
- The vitest pool exports no `fetchMock`, so the suites that assert on an outbound HTTP request
  stub the global `fetch` with `vi.stubGlobal` and undo it in `afterEach`. `test/webhooks.test.ts`
  does that; the queue handler itself is driven with `createMessageBatch` and `getQueueResult` from
  `cloudflare:test`.
- `z.toJSONSchema` emits `$ref` between schemas only when it is handed a `z.registry` and a `uri`
  callback; called on a schema directly it inlines every nested schema. `components.schemas` is
  therefore one call over a registry of every named schema, and the path and query parameters are
  separate per-object calls, which is safe because no parameter references a named schema.
- `z.toJSONSchema` stamps `$schema` on what it returns, and `$id` as well on the registry form.
  Both are stripped in `src/http/openapi.ts` before the result goes into the document, and
  `test/openapi.test.ts` asserts neither survives.
- A route table entry keyed on a zod schema is matched by object identity, so a schema reused in
  two places must be the same binding. `signup_body` and the MCP `signup` input are the one const;
  writing an equivalent `z.object({...})` in either place would inline it instead of `$ref`ing the
  component.
- `scripts/lib/` imports `src/email/transports/secrets.ts` for the transport names and their
  secret lists, which is the one place a setup module reaches into `src/`. That file holds data and
  no imports on purpose: Node strips its types and loads it, and anything it imported would have to
  load under Node as well.
- `pnpm setup` runs pnpm's own built-in `setup` command, not the repo script. Invoke it as
  `pnpm run setup`.
- `scripts/` has no `@types/node`; `scripts/node.d.ts` declares only the `node:*` shapes used.
  Extend that file rather than installing `@types/node`, which would collide with the
  workers-types globals.
- The setup's test suites run inside workerd like every other suite, so they may only import setup
  modules that touch no Node API. `scripts/lib/consent.ts` is kept free of `node:*` imports for
  that reason: the TTY check, the writer and the line reader are injected as a `ConsentIo`, and the
  real one (`terminalConsent`) lives in `scripts/lib/runtime.ts` and is attached to `SetupContext`
  in `scripts/setup.ts`.
- `JSON.stringify` does not match biome's formatting of `wrangler.jsonc`, so every config write the
  setup makes is followed by `pnpm exec biome format --write`. Re-check if biome's formatting
  changes.
- Biome GritQL snippet patterns do not match `let` declarations, so `lint/no-let.grit` matches
  `variable_declaration()` nodes and filters on their text with a regex. Re-check the pattern if
  Biome is upgraded. `lint/` is excluded from `files.includes` so the formatter leaves the plugin
  source alone.
- `unpdf` bundles pdf.js and is most of the Worker's size: the bundle is 3912 KiB, 850 KiB gzipped,
  up from 1496 KiB and 274 KiB before attachment text extraction. That is well inside the Workers
  Paid limit but it is the first dependency large enough to matter, so weigh anything comparable
  against what it buys.
- Extraction runs inline in `ingestInbound`, after the rows are written, once per supported
  attachment. A PDF costs pdf.js a parse of the whole file plus a copy of its bytes, so a mail
  carrying several large PDFs adds CPU and memory to an ingest that Email Routing is waiting on.
  The 10 MiB input cap is what bounds it; move extraction off the ingest path before raising that.
- Cloudflare does not document a stable error code for the per-zone Email Routing rule cap, so
  `src/lib/cloudflare.ts` recognizes it by matching the error message against
  `/\b(limit|maximum|max number|too many|exceed)/i`. A message that changes wording turns the cap
  back into a plain 503 `routing_unavailable`; re-check the regex against a real cap response.
- The setup's Routing rules step reads the deployment's inboxes with `wrangler d1 execute --remote`
  and writes the rule ids back the same way, because the setup is a Node script with no D1 binding.
  Values are quoted by doubling `'`; an address cannot contain one today, and the escaping is there
  so that stays true if the username rules loosen.
- Subdomain mode leaves the zone apex without Cloudflare MX records, so the Cloudflare dashboard
  reports the zone's Email Routing status as `misconfigured`. That is cosmetic and expected;
  delivery to the subdomain works, the setup does not read that field, and it must not start
  treating it as an error.
