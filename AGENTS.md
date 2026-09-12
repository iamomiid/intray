# intray

Open-source service giving AI agents real email inboxes: create an inbox, receive mail, read
threads, reply, wait for a message. There is no dashboard and no config UI; the surface is a REST
API and an MCP server, and an agent onboards itself and holds the API key.

## Stack

One Cloudflare Worker. Email Routing (inbound) and Email Sending (outbound), D1 for
accounts/inboxes/threads/messages, R2 for raw MIME and attachments. Hono for HTTP, `agents/mcp` plus
`@modelcontextprotocol/server` for MCP, `postal-mime` for parsing, zod for schemas.

## Working rules

- Package manager is pnpm. Node 22 or newer. Never use npm or yarn in this repo.
- **No comments in code.** No `//`, no `/* */`, no JSDoc, none in SQL or JSON. Name things so the
  comment is unnecessary.
- **No `let` anywhere**, enforced by `lint/no-let.grit` through Biome's plugin support. Bind with
  `const` and restructure: a helper that returns the value, a ternary, `map`/`reduce`, or a
  recursive helper that takes the state as parameters.
- HTTP routes and MCP tools are thin adapters over `src/core`. No business logic in either adapter.
- Strict TypeScript. Explicit types at module boundaries. No `any`.
- Documentation describes the current state and is updated in place. No session logs, no dated
  entries, no history. When a decision changes, the doc changes.
- Docs are public and read by humans as well as agents: terse, factual, considerate. No marketing
  prose, no badges. No account ids, domains, addresses, or Worker URLs; use `example.com`,
  `agents.example.com`, `you@example.com`, `https://intray.example.workers.dev`.
- Do not name any commercial product as inspiration, anywhere in the repo.
- The repo is public. Nothing that identifies a deployment or a person goes into a commit, a
  commit message, a PR description, an issue, or a test fixture: no real mail domain, address,
  Worker URL, account, zone or database id, token, or secret, whether it is this deployment's or a
  maintainer's own. CI rejects non-placeholder addresses, `workers.dev` URLs and 32-hex or UUID
  identifiers, and runs a secret scanner.
- A PR description is bullets and tables only, no paragraph over two sentences, with these
  sections in order, "None" rather than omitted: What, Surface (a table of every new or changed
  endpoint, tool, field, var and migration), Changes (grouped by area), Decisions (each with its
  reason), Tests (one bullet per behavior, then counts before and after), Verified outside the
  suite, Not in this PR, Needs from the maintainer (each bullet starts with the action).
- `scripts/` is a product surface, not scaffolding. Keep it DRY, share helpers under `scripts/lib`,
  and write no one-off code there.
- Run `pnpm check` (lint, typecheck, test) before finishing. CI runs the same on every pull
  request and on `main`; a red check blocks the merge.

## Layout

```
.github/                CI workflow and the identifier check it runs
wrangler.jsonc          bindings, vars, compatibility date
migrations/             D1 migrations, applied with pnpm db:migrate:local
lint/no-let.grit        Biome GritQL plugin that rejects a let declaration
scripts/setup.ts        the setup command; steps and helpers in scripts/lib
src/index.ts            fetch (/mcp then Hono) and email exports
src/env.ts              Env bindings interface and config(env)
src/http/               Hono app, auth middleware, /v1 routes
src/mcp/                MCP handler, server factory, tool registration
src/email/              inbound handler, threading, outbound builders
src/core/               service layer: the only place with business logic
src/db/                 typed D1 helpers
src/lib/                ids, otp, hash, errors, pagination, address, limits
public/skill.md         onboarding instructions served at /skill.md and /llms.txt
test/                   vitest suites running in workerd
```

## Commands

`pnpm dev`, `pnpm test`, `pnpm typecheck`, `pnpm lint`, `pnpm format`, `pnpm check`,
`pnpm db:migrate:local`, `pnpm db:migrate:remote`, `pnpm deploy`, `pnpm run login`.

`pnpm run login` is `wrangler login` with the scopes setup needs, including `email_routing:write`
and `email_sending:write`, which the default `wrangler login` omits.

```
pnpm run setup --domain agents.example.com [--email you@example.com]
  [--allow-signup you@example.com] [--operator-token [value]] [--dmarc-reports]
  [--accept-changes] [--yes]
```

The setup runs the whole of `docs/deploy.md` idempotently: D1, R2, migrations, vars, deploy,
operator token, Email Routing, Email Sending, DMARC reports, destination address, mail domain. It
needs no API token: it uses the OAuth token from `pnpm run login`, and `CLOUDFLARE_API_TOKEN` only
if one is set. `--dmarc-reports` is the one step that an API token can do and the OAuth token
cannot. Invoke it as `pnpm run setup`, not `pnpm setup`, which is pnpm's own command.

`--domain` takes a zone apex or a subdomain of one; a subdomain leaves the apex MX and DMARC alone
and is the recommended shape. Every change that cannot be undone or that alters how the domain's
mail flows is described and asked about first; `--accept-changes` approves them, `--yes` never does.

## Read next

- `docs/architecture.md` — components, data flow, data model, the conventions and why they hold
- `docs/status.md` — status per subsystem, limitations, gotchas
- `docs/api.md` — REST and MCP contract, the source of truth for adapters
- `docs/deploy.md` — operator guide for standing up a deployment
- `public/skill.md` — what an agent is told when it onboards itself
- `ROADMAP.md` — ordered future work
