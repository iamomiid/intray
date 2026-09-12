# Status

What is built, and what a contributor needs to know before touching it. Design rationale lives in
`docs/architecture.md`; planned work lives in `ROADMAP.md`.

## Subsystems

| Subsystem | Status | Notes |
| --- | --- | --- |
| scaffold | done | pnpm, `wrangler.jsonc`, tsconfig, biome with the `lint/no-let.grit` plugin, vitest-in-workerd |
| ci | done | `.github/workflows/ci.yml` on pull requests and `main`: lint, typecheck, tests, forbidden-identifier check, gitleaks |
| db | done | one module per table plus `rows.ts` and `index.ts`; keyset pagination |
| lib | done | `address`, `hash`, `otp`, `pagination`, `limits`, `time`, `rfc`, `errors`, `ids` |
| accounts, keys, OTP | done | signup, verify, me, authenticate, key create/list/revoke; pending keys for repeat signup; `ALLOWED_SIGNUP_EMAILS` |
| operator token | done | `src/core/operator.ts`; `OPERATOR_TOKEN` resolves to `acc_operator`, checked before the key-hash lookup |
| inboxes | done | create, get, list, delete with R2 cleanup, plus `requireInbox` |
| inbound | done | `src/email/{inbound,threading,parse}.ts`; `email()` stores to D1 and R2 |
| outbound | done | recipient normalization, send/reply/forward builders, limit checks, send-error mapping |
| core services | done | `serialize`, `principal`, `accounts`, `keys`, `inboxes`, `threads`, `messages`, `attachments`, `orgs`, `audit` |
| http | done | `types.ts`, `auth.ts`, `body.ts`, one router per resource; every `/v1` endpoint in `docs/api.md` |
| schemas | done | `src/schemas/`, one module per resource plus `objects.ts`; the MCP tools' `inputSchema` and the OpenAPI document both read from it, and `test/schemas.test.ts` parses a serialized row of each kind against its schema |
| openapi | done | `GET /openapi.json`, built in `src/http/openapi.ts` from a route table and `z.toJSONSchema`, served by `src/http/routes/openapi.ts`; `test/openapi.test.ts` compares the document against `app.routes` in both directions |
| mcp | done | `src/mcp/{server,tools,result}.ts`; 3 onboarding tools without a live key, 45 with one |
| setup | done | `pnpm run login` then `pnpm run setup`; apex and subdomain modes, consent prompts, idempotent steps |
| subaddressing | done | `splitTag` and `tagLabel` in `src/lib/address.ts`; inbound tags become labels, `from` on send/reply/forward may be subaddressed |
| batch operations | done | message label and delete batches, thread label update and delete; one `db.batch` per request, R2 cleanup and thread recount in `src/core/{messages,threads}.ts` |
| message search | done | `searchMessages` runs against the `messages_fts` FTS5 table, ranked by `bm25` with the subject weighted above the body; the `from`/`to`/`subject` filters on `list_messages` stay `LIKE` scans and are fine at v1 volumes |
| drafts | done | `src/core/drafts.ts`, `migrations/0004_drafts.sql`; create, list, get, update, delete, send now, and a one-minute cron trigger draining due scheduled drafts through `sendMessage` and `replyToMessage` |
| orgs | done | `src/core/orgs.ts`, `src/core/audit.ts`, `migrations/0006_company.sql`; `ADMIN_SECRET` bootstraps one org, invites are accepted through signup, admins provision inboxes to members, API keys take `inbox:` scopes enforced in core, and an append-only audit log covers the admin actions |
| webhooks | done | `src/core/webhooks.ts`; per-account https endpoints for `message.received` and `message.sent`, HMAC-SHA256 signed, delivered and retried through the `intray-webhooks` queue |
| usage | done | `src/core/usage.ts`, `src/db/usage.ts`, `migrations/0007_usage.sql`; upsert counters for messages sent, messages received and stored bytes, read through `GET /v1/usage` or `get_usage`, enforced as `QUOTA_MESSAGES_SENT_PER_MONTH`, `QUOTA_MESSAGES_RECEIVED_PER_MONTH` and `QUOTA_STORAGE_BYTES` |
| attachments | partial | `core.listAttachments` has no HTTP route; attachments are embedded on message objects and downloaded one at a time. Text is extracted from PDF and docx on ingest into `attachments.text`, read through `GET .../attachments/:attachment_id/text` or `get_attachment`; `text_status` rides on every attachment object |

## Limitations

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
- Nothing expires R2 raw MIME objects. They are removed only by the explicit inbox, thread and
  message delete paths, so a busy deployment grows without bound.
- Threading has no subject-based fallback. A reply from a client that drops both `In-Reply-To` and
  `References` starts a new thread.
- `reply_all` puts every merged recipient in `To` and never in `Cc`, and a forward re-sends the
  parent's inline attachments as ordinary attachments. Both are simplifications.
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
- The pool does not roll D1 back between tests in a file, so writes leak from one test to the next.
  `test/support.ts` exports `resetDatabase(db)`; call it in `beforeEach` of any suite that writes.
  It does not clean up R2 objects.
- `vitest.config.ts` pins `MAIL_DOMAINS`, `INBOX_LIMIT`, `PUBLIC_URL`, `ALLOWED_SIGNUP_EMAILS`, the
  three `QUOTA_*` vars, `OPERATOR_TOKEN` and `ADMIN_SECRET` in the miniflare bindings, so changing the deployment vars in `wrangler.jsonc`
  cannot move the suite. HTTP and MCP suites must use the operator-token constant from
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
- Subdomain mode leaves the zone apex without Cloudflare MX records, so the Cloudflare dashboard
  reports the zone's Email Routing status as `misconfigured`. That is cosmetic and expected;
  delivery to the subdomain works, the setup does not read that field, and it must not start
  treating it as an error.
