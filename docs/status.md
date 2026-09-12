# Status

What is built, and what a contributor needs to know before touching it. Design rationale lives in
`docs/architecture.md`; planned work lives in `ROADMAP.md`.

## Subsystems

| Subsystem | Status | Notes |
| --- | --- | --- |
| scaffold | done | pnpm, `wrangler.jsonc`, tsconfig, biome, vitest-in-workerd |
| db | done | one module per table plus `rows.ts` and `index.ts`; keyset pagination |
| lib | done | `address`, `hash`, `otp`, `pagination`, `limits`, `time`, `rfc`, `errors`, `ids` |
| accounts, keys, OTP | done | signup, verify, me, authenticate, key create/list/revoke; pending keys for repeat signup; `ALLOWED_SIGNUP_EMAILS` |
| operator token | done | `src/core/operator.ts`; `OPERATOR_TOKEN` resolves to `acc_operator`, checked before the key-hash lookup |
| inboxes | done | create, get, list, delete with R2 cleanup, plus `requireInbox` |
| inbound | done | `src/email/{inbound,threading,parse}.ts`; `email()` stores to D1 and R2 |
| outbound | done | recipient normalization, send/reply/forward builders, limit checks, send-error mapping |
| core services | done | `serialize`, `principal`, `accounts`, `keys`, `inboxes`, `threads`, `messages`, `attachments` |
| http | done | `types.ts`, `auth.ts`, `body.ts`, one router per resource; every `/v1` endpoint in `docs/api.md` |
| mcp | done | `src/mcp/{server,tools,result}.ts`; 3 onboarding tools without a live key, 18 with one |
| setup | done | `pnpm run login` then `pnpm run setup`; apex and subdomain modes, consent prompts, idempotent steps |
| subaddressing | done | `splitTag` and `tagLabel` in `src/lib/address.ts`; inbound tags become labels, `from` on send/reply/forward may be subaddressed |
| message search | partial | `searchMessages` and the `from`/`to`/`subject` filters are `LIKE` scans; fine at v1 volumes, replaced by FTS5 in roadmap item 6 |
| attachments | partial | `core.listAttachments` has no HTTP route; attachments are embedded on message objects and downloaded one at a time |

## Limitations

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

## Gotchas

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
- The pool does not roll D1 back between tests in a file, so writes leak from one test to the next.
  `test/support.ts` exports `resetDatabase(db)`; call it in `beforeEach` of any suite that writes.
  It does not clean up R2 objects.
- `vitest.config.ts` pins `MAIL_DOMAINS`, `INBOX_LIMIT`, `PUBLIC_URL`, `ALLOWED_SIGNUP_EMAILS` and
  `OPERATOR_TOKEN` in the miniflare bindings, so changing the deployment vars in `wrangler.jsonc`
  cannot move the suite. HTTP and MCP suites must use the operator-token constant from
  `test/support.ts`, because `SELF.fetch` takes no per-request env override.
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
- Subdomain mode leaves the zone apex without Cloudflare MX records, so the Cloudflare dashboard
  reports the zone's Email Routing status as `misconfigured`. That is cosmetic and expected;
  delivery to the subdomain works, the setup does not read that field, and it must not start
  treating it as an error.
