# Deploy

One command does the whole checklist. The manual steps are kept below it as a fallback.

## Prerequisites

- A Cloudflare account on the **Workers Paid** plan. Email Sending is not available on the free
  plan, so outbound will fail without it.
- A domain whose DNS is hosted on Cloudflare, in the same account. This is the mail domain.
- `pnpm install` has been run.

## Pick the mail domain first

`--domain` takes either a zone apex or a subdomain of a zone in the same account.

**If the apex already carries human mail, use a subdomain.**

```
pnpm run setup --domain agents.example.com --operator-token --yes
```

The apex keeps its own MX records and its mail keeps flowing. Cloudflare adds routing and sending
records for `agents.example.com` only, and the `_dmarc` record with `p=reject` lands on
`_dmarc.agents.example.com`, not on `_dmarc.example.com`, so a strict policy applies to the agent
mail alone. Addresses look like `agent@agents.example.com`. If the deployment goes wrong the blast
radius is one subdomain: delete its records and the apex is untouched.

One cosmetic effect: with routing enabled on the zone but no Cloudflare MX on the apex, the
Cloudflare dashboard shows the zone's Email Routing status as `misconfigured`. That is expected in
subdomain mode, the setup does not treat it as an error, and subdomain delivery works regardless.

**Use the apex when the domain is dedicated to this deployment** and nothing else receives mail on
it:

```
pnpm run login
pnpm run setup --domain example.com --operator-token --yes
```

Enabling Email Routing on an apex replaces its MX records with Cloudflare's, and Email Sending
writes `_dmarc` with `p=reject` there. Both are asked about before they happen, and the prompt says
so explicitly when the apex has MX records Cloudflare does not own.

## Run it

A personal deployment needs no signup at all. Set one secret and connect the agent with it:

```
pnpm run login
pnpm run setup --domain agents.example.com --operator-token --yes
```

The setup prints the operator token once, under its own heading, together with the line to paste:

```
claude mcp add --transport http intray https://intray.example.workers.dev/mcp \
  --header "Authorization: Bearer op_..."
```

That is the whole onboarding. The token authenticates as `acc_operator`, an account that is
verified from the start, so the agent may create inboxes, read mail, and send to anyone
immediately. The token is shown only once; re-run with `--operator-token <value>` to replace it.
Add `--email you@example.com` to register a verified destination address as well.

Signup stays available for a multi-user deployment: agents onboard themselves through `POST
/v1/agent/signup` and a 6-digit code, as described in `public/skill.md`, and `--allow-signup`
narrows who may do it. Omit `--operator-token` and nothing changes from that path.

`pnpm run login` is `wrangler login` with the `email_routing:write` and `email_sending:write`
scopes. The setup uses that OAuth token for the Cloudflare API too, so nothing else is needed. Run
it again if the setup reports a missing scope or an expired login.

Use `pnpm run setup`, not `pnpm setup`: `setup` is also a built-in pnpm command and pnpm's own
takes precedence.

Flags:

- `--domain` — required, the mail domain. Either a zone in the logged-in account, or a subdomain of
  one. The setup tries the full name against `/zones?name=`, then strips one leading label at a
  time until a zone matches, so `agents.example.com` resolves to the `example.com` zone and runs in
  subdomain mode. See **Pick the mail domain first**.
- `--email` — optional. Registers a verified destination address so sends reach it before the
  sending domain is verified, and is used as the address in the printed signup command.
- `--allow-signup` — optional, a comma-separated list of email addresses. Sets
  `ALLOWED_SIGNUP_EMAILS`, after which only those addresses may sign up and any other gets 403
  `signup_closed`. Omit it and the existing value is kept, defaulting to `""`, which leaves signup
  open to anyone who can reach the Worker. Pass the whole list every time; it replaces, not
  appends.
- `--operator-token` — optional, with an optional value. Sets the `OPERATOR_TOKEN` Worker secret,
  which authenticates as the operator account with no signup. Without a value the setup generates
  `op_` plus 32 random bytes base64url and prints it once; with a value it uses that value, which
  must be at least 32 characters. When the secret already exists and no value was given the step is
  skipped, so re-running does not rotate it; pass a value to replace it. Omit the flag entirely and
  the secret is left alone.
- `--dmarc-reports` — optional. Turns on Cloudflare DMARC Management for the zone, which collects
  the aggregate DMARC reports. Off without the flag. See **DMARC reports** below.
- `--accept-changes` — optional. Approves, without asking, every change that alters existing mail
  or DNS. See **Approvals** below.
- `--yes` — do not ask for confirmation of the printed plan. Confirmation is also skipped when
  stdin is not a TTY. It never approves the changes under **Approvals**; those need
  `--accept-changes`.
- `--help` — usage.

## Approvals

Anything that cannot be undone, or that changes how the domain's mail flows today, is described and
asked about before it happens. The prompt prints the title, the records or values involved, a
`reversible: yes/no` line, and `Apply this change? [y/N] `. Record lists are deduplicated, and a
value longer than 80 characters, such as a DKIM key, is cut with `…` while the type and name stay
in full. Anything other than `y` or `yes` stops the setup at that step with `declined`, and nothing
has been changed.

`--yes` does not cover these; it only skips the confirmation of the printed plan.
`--accept-changes` covers all six, and still prints each one so the log records what was applied.
Without a TTY and without `--accept-changes` the setup stops with the change described in the
error, so CI has to opt in deliberately after reading it.

The six:

1. **Enable Email Routing on the apex** — apex mode only. Reads
   `GET /zones/{zone}/email/routing/dns` first and lists the records Cloudflare will add. When that
   diff reports a foreign MX, the prompt says the apex receives mail elsewhere today and that this
   replaces its MX records. Not reversible.
2. **Add the subdomain routing records** — subdomain mode only. Lists the missing records from
   `GET /zones/{zone}/email/routing/dns?subdomain=<domain>`. Reversible: deleting them undoes it.
3. **Replace the catch-all rule** — only when a rule already exists, is enabled, and does not
   already target the Worker. Shows the current action and the new one. Not reversible: the setup
   does not restore the old target.
4. **Write the Email Sending DNS records** — lists the records from
   `GET .../sending/subdomains/{tag}/dns/status`. On an apex the prompt says it writes `_dmarc`
   with `p=reject` there, which rejects any other sender for the domain that is not aligned; not
   reversible. On a subdomain it is reversible.
5. **Replace an existing operator token** — only when `OPERATOR_TOKEN` is already set and an
   explicit value was given. Not reversible: every client on the old token stops working at once
   and the old value cannot be read back.
6. **Enable DMARC reports** — modifies the `_dmarc` record. Reversible.

Creating D1, R2 and the queue, applying migrations, writing vars, deploying, setting an operator
token that did not exist, and turning the Email Routing setting on for a zone in subdomain mode
(`PATCH /zones/{zone}/email/routing`, which touches no DNS) are not asked about.

## API token instead of the login

For CI, or an account that cannot use the browser login, put an API token in `.env` at the repo
root as `CLOUDFLARE_API_TOKEN=...`, or export it. `.env` is gitignored. An API token takes
precedence over the wrangler login. Create the token at
https://dash.cloudflare.com/profile/api-tokens with:

- Zone — Zone — Read
- Zone — Zone Settings — Edit
- Zone — DNS — Edit
- Zone — Email Routing Rules — Edit
- Account — Email Routing Addresses — Edit
- Account — Workers Scripts — Read
- any Email Sending permission the token editor offers
- Zone — DMARC Management — Edit, only needed for `--dmarc-reports`. Look for it under the Zone
  permissions in the token editor

Credentials are resolved in this order: `CLOUDFLARE_API_TOKEN` from the environment, then
`CLOUDFLARE_API_TOKEN` from `.env`, then the OAuth token in wrangler's own config file. Without any
of the three the script fails at the **Credentials** step, before anything is created or changed.

## What the setup does, in order

Every step checks the current state first, so re-running is safe and any step that is already
correct prints `skipped`.

1. **Login** — `wrangler whoami`, reads the account id. Stops with `pnpm run login` if
   unauthenticated. This call also refreshes an expired OAuth token on disk.
2. **Credentials** — with an API token, uses it. Otherwise reads the OAuth token wrangler just
   refreshed, checks it has not expired and that its scopes include `email_routing:write` and
   `email_sending:write`, and uses it for every Cloudflare API call. Fails here, before anything is
   created, when there are no usable credentials.
3. **D1 database** — creates `intray` if `d1 list` does not have it, then writes the uuid into
   `wrangler.jsonc` at `d1_databases[0].database_id`.
4. **R2 bucket** — creates `intray` if `r2 bucket list` does not have it.
5. **Queue** — creates the `intray-webhooks` queue if `queues info intray-webhooks` does not find
   it. The Worker declares a producer and a consumer on it, so a deploy fails while it is missing.
6. **Migrations** — `d1 migrations apply intray --remote`.
7. **Vars** — sets `PUBLIC_URL` to the Worker's `workers.dev` URL, read from the account's Workers
   subdomain, defaults `INBOX_LIMIT` to `10`, and writes `ALLOWED_SIGNUP_EMAILS` from
   `--allow-signup` or leaves the current value alone, defaulting it to `""`. `MAIL_DOMAINS` is not
   written here; see step 15.
8. **Deploy** — `wrangler deploy`, reads the `workers.dev` URL from the output. Deploys a second
   time if `PUBLIC_URL` did not already match it.
9. **Operator token** — with `--operator-token`, checks `wrangler secret list` for `OPERATOR_TOKEN`
   and puts the secret over stdin unless it already exists and no explicit value was given.
   Replacing one that already exists needs approval 5. Skipped without the flag.
10. **Zone** — looks up `--domain`, then each parent in turn, until `/zones?name=` matches. Fails
    listing every name it tried if none is a zone in this account. When the matched zone name is
    not the given domain the rest of the run is in **subdomain mode**.
11. **Email Routing** — apex mode: enables routing with
    `POST /zones/{zone}/email/routing/enable`, which adds the apex MX, SPF and DKIM records
    (approval 1). Subdomain mode: turns the setting on with
    `PATCH /zones/{zone}/email/routing {enabled, skip_wizard}` and reads it back, which writes no
    DNS, then adds the subdomain's own records with
    `POST /zones/{zone}/email/routing/dns {"name": "<domain>"}` (approval 2) and re-reads until the
    zone reports none missing. It never calls `/email/routing/enable` in subdomain mode, so the
    apex MX records are left alone. If the setting cannot be turned on it stops and asks for it to
    be enabled in the dashboard without accepting the suggested apex records. Then it points the
    catch-all rule at the `intray` Worker (approval 3 when a different rule is already enabled).
    The catch-all is zone-level and covers the subdomain's mail too.
12. **Email Sending** — onboards the domain as a sending subdomain, applies the DNS records
    (approval 4), and polls the record status every 5 s for up to 3 minutes until it is clean.
    Stops with the list of conflicting records if existing DNS is in the way. The endpoint takes an
    apex or a subdomain, so this is the same in both modes.
13. **DMARC reports** — with `--dmarc-reports`, turns on Cloudflare DMARC Management for the zone
    (approval 6). Skipped without the flag, skipped in subdomain mode with
    `apex only; would change the zone apex`, and skipped with a message when the credentials are
    the wrangler login rather than an API token. See **DMARC reports** below.
14. **Destination address** — with `--email`, registers it as a routing destination. Cloudflare
    emails a verification link that has to be clicked.
15. **Mail domain** — writes `MAIL_DOMAINS` to `--domain` exactly, subdomain included, and deploys
    again if the value changed.

The mail domain is written last, after the mail steps have succeeded, so a declined DNS change or a
failed sending onboarding never leaves a deployed Worker handing out addresses on a domain that
cannot receive mail. A first run therefore deploys twice: once to create the Worker that Email
Routing points at, and once to publish the mail domain.

It then prints the public URL, the onboarding doc URL, the `claude mcp add` line, and a signup
`curl`. When a token was set on that run the `claude mcp add` line carries the real token and the
token is printed once under its own heading; otherwise the line shows a `<key>` placeholder.

The script only writes `wrangler.jsonc`; it never writes `.env`, never prints the Cloudflare
credentials, and feeds the operator token to `wrangler secret put` over stdin rather than on the
command line.

## wrangler.jsonc is edited by the setup

The setup writes `d1_databases[0].database_id` and the `vars` block into `wrangler.jsonc`, so after
a run that file holds the deployment's database id, mail domain and public URL. That is convenient
for a private deployment and wrong for a published fork: keep placeholders in git, and either keep
the local edits out of a commit or move them to a `wrangler.<name>.jsonc` used with
`wrangler --config`. The test suite does not read those values — `vitest.config.ts` pins its own —
so a placeholder in git costs nothing.

## DMARC reports

Optional, and nothing else depends on it. Cloudflare's DMARC Management appends a Cloudflare-owned
`rua=` reporting address to the zone's existing `_dmarc` TXT record, so the aggregate reports mail
servers send back are collected and shown in the dashboard under **Email** → **DMARC Management**.
It is a read-only view of who is sending as the domain; it changes no delivery behavior.

Two constraints. It works on apex zones only — Cloudflare does not offer it on a subdomain — so
with `--domain agents.example.com` the step reports `skipped (apex only; would change the zone
apex)` and does nothing, rather than editing `_dmarc` on the zone apex. And it needs an **API
token**: wrangler's OAuth token cannot call the endpoint at all, so with the login the step reports

```
↷ DMARC reports — skipped (needs an API token; enable it in the dashboard: Email → DMARC Management → Enable DMARC Management)
```

and repeats that line in the summary. One click in the dashboard does the same thing, so an API
token is worth creating only if this has to be scripted.

With a token, the step reads the current state, skips when it is already on, and otherwise turns it
on and reads it back to confirm. A 403 means the token is missing **Zone — DMARC Management —
Edit**.

## Check the deployment

Health:

```
curl -s https://intray.example.workers.dev/healthz
```

Expect `{"ok":true}`.

Onboarding doc:

```
curl -s https://intray.example.workers.dev/skill.md | head
```

Sign up and capture the key:

```
curl -s -X POST https://intray.example.workers.dev/v1/agent/signup \
  -H 'content-type: application/json' \
  -d '{"email":"you@example.com","username":"agent"}'
```

Verify with the emailed code:

```
curl -s -X POST https://intray.example.workers.dev/v1/agent/verify \
  -H "authorization: Bearer $KEY" \
  -H 'content-type: application/json' \
  -d '{"code":"123456"}'
```

Send real mail to the returned `inbox_id` from an external account, then list it:

```
curl -s -H "authorization: Bearer $KEY" \
  "https://intray.example.workers.dev/v1/inboxes/agent%40agents.example.com/messages"
```

## Local development

```
pnpm db:migrate:local
pnpm dev
```

To use an operator token locally, put it in `.dev.vars`, which is gitignored:

```
OPERATOR_TOKEN=op_local_development_token_at_least_32_chars
```

Inject an inbound message. The body must be raw RFC 5322 and must include a `Message-ID` header:

```
curl -X POST 'http://localhost:8787/cdn-cgi/local/email?from=sender@example.net&to=agent@intray.example' \
  --data-binary @test/fixtures/plain.eml
```

`send_email` is declared with `"remote": true`, so `pnpm dev` sends real mail through the deployed
binding.

Register the MCP endpoint with a client:

```
claude mcp add --transport http intray http://localhost:8787/mcp --header "Authorization: Bearer $KEY"
```

The test suite pins `MAIL_DOMAINS`, `INBOX_LIMIT`, `PUBLIC_URL`, `ALLOWED_SIGNUP_EMAILS`, the three
`QUOTA_*` vars and
`OPERATOR_TOKEN` in `vitest.config.ts`, so changing those vars in `wrangler.jsonc` does not move
the suite.

## Rollback

```
pnpm wrangler rollback
```

Migrations are not rolled back by that command. Write a new forward migration instead of reverting
one that has been applied remotely.

## Manual checklist

The fallback when `pnpm run setup` cannot run, and the description of what it automates.

### 1. Create the D1 database

```
pnpm wrangler d1 create intray
```

Copy the printed `database_id` into `wrangler.jsonc` at `d1_databases[0].database_id`.

### 2. Create the R2 bucket

```
pnpm wrangler r2 bucket create intray
```

### 3. Create the queue

```
pnpm wrangler queues create intray-webhooks
```

The Worker declares a producer binding and a consumer on this queue, so a deploy fails while it
does not exist. Queues need the Workers Paid plan.

### 4. Apply migrations

```
pnpm db:migrate:remote
```

Use `pnpm db:migrate:local` for the local dev database.

### 5. Set the vars

Edit `vars` in `wrangler.jsonc`:

- `INBOX_LIMIT` — per-account inbox cap, as a string. Default `10`.
- `PUBLIC_URL` — the deployed origin with no trailing slash, e.g.
  `https://intray.example.workers.dev`.
- `ALLOWED_SIGNUP_EMAILS` — comma-separated addresses allowed to sign up. `""` leaves signup open.
- `QUOTA_MESSAGES_SENT_PER_MONTH` — per-account cap on messages sent in a UTC month, as a string.
  `""` or `0` is unlimited.
- `QUOTA_MESSAGES_RECEIVED_PER_MONTH` — per-account cap on messages received in a UTC month, as a
  string. `""` or `0` is unlimited.
- `QUOTA_STORAGE_BYTES` — per-account cap on stored bytes, as a string. `""` or `0` is unlimited.

Leave `MAIL_DOMAINS` until step 9, once the domain can actually receive and send.

`OPERATOR_TOKEN` is a secret, not a var. Never put it in `wrangler.jsonc`:

```
pnpm wrangler secret put OPERATOR_TOKEN
```

### 6. Deploy

```
pnpm deploy
```

The Worker must exist before Email Routing can be pointed at it, so deploy before step 7. If
`PUBLIC_URL` was not known before the first deploy, set it from the URL the deploy prints and
deploy again.

### 7. Enable inbound: Email Routing

In the Cloudflare dashboard, open the zone, then **Email** → **Email Routing**, and enable it.
Accept the MX, SPF, and DKIM records it adds.

For a subdomain deployment, do not accept the apex MX records: enable Email Routing, then add the
records for the subdomain alone under **Email Routing** → **Settings** → the subdomain entry. The
zone will then read `misconfigured` because the apex has no Cloudflare MX, which is correct and
does not affect subdomain delivery.

Then under **Routing rules**, edit the **Catch-all address**: set the action to **Send to a Worker**
and select `intray`. Enable the catch-all rule. The catch-all is zone-level and covers the
subdomain.

### 8. Enable outbound: Email Sending

In the same **Email** section, open **Email Sending** and onboard the sending domain. Cloudflare
adds a `cf-bounce` MX record plus SPF, DKIM, and DMARC. Wait for the domain to report as verified.

Until the domain is onboarded, sends only reach addresses that are verified destination addresses
on the account. Once it is, any local part on that domain can send.

### 9. Set the mail domain

Only now set `MAIL_DOMAINS` in `wrangler.jsonc` — comma-separated, no spaces, the first entry being
the default for new inboxes — and deploy again. Doing it last means the Worker never hands out
addresses on a domain that cannot yet receive mail.

Repeat steps 6 and 7 for every domain listed in `MAIL_DOMAINS`.
