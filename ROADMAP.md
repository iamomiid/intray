# Roadmap

Ordered. Each item is additive; v1 data model already reserves the columns the early items need.

## 1. Custom domains per account

Register an account-owned domain through the Cloudflare API: run sending-domain onboarding and
route inbound per item 2, one rule per inbox on the account's domain. Adds
`domains(domain, account_id, verified_at)` and drops the reliance on a single operator-wide
`MAIL_DOMAINS`.

## 2. Per-inbox routing rules

The setup points the zone's Email Routing catch-all at the Worker, and the Worker rejects unknown
recipients itself with `550 no such inbox`. The MX therefore accepts mail for every address on the
domain before anything rejects it, which address harvesters and reputation systems notice, and the
catch-all claims the whole domain, so nothing else can hold an address on it. Replace it with one
Email Routing rule per inbox, so the domain only ever accepts mail for addresses that exist and the
operator's other addresses on the same domain keep working.

`createInbox` adds a rule with a `literal` matcher on the full address and a `worker` action, and
stores its id in a new `inboxes.routing_rule_id` column; `deleteInbox` removes the rule before the
row. A failed rule creation fails the create, so an inbox never exists without its route, and a
re-run of the setup reconciles drift in both directions: rules for inboxes that have none, and
rules pointing at the Worker for addresses with no inbox. The Worker needs the zone id and a
zone-scoped API token with `email_routing:write` as a secret; item 1 uses the same client. Email
Routing caps rules per zone, which bounds the total inbox count across accounts; `createInbox`
surfaces that as `inbox limit reached` rather than as a routing error.

Routing mode is a `ROUTING_MODE` var, `per_inbox` or `catch_all`, written by the setup from a
`--routing` flag. Switching an existing deployment to `per_inbox` creates the rules first and then
disables the catch-all, which changes how the domain's mail flows and so is asked about. The
Worker's own `550 no such inbox` stays as the backstop for `catch_all` mode and for a stale rule.

Before the catch-all can go, verify that a `literal` rule delivers subaddressed mail
(`desk-agent+invoices@`) to the `desk-agent@` rule. If it does not, subaddressing is limited to
`catch_all` mode until it does.

## 3. Pluggable mail providers

Let a deployment run inbound, outbound, or both through a provider other than Cloudflare Email
Routing and Email Sending: SMTP, Amazon SES, Resend, or any other mail API. Each provider is one
module behind a transport interface, so adding another is a file, not a redesign.

Outbound. `send(env, builder)` in `src/email/outbound.ts` is already the single call site, but the
builders hand it an `EmailMessageBuilder`, which only the `send_email` binding can consume. Move the
build step to a provider-neutral `OutboundMessage` (headers, text and html parts, attachments) and
add a `MailTransport` with one `send(message)` method returning the RFC message id. Transports:
`cloudflare` (renders into an `EmailMessageBuilder`, keeps the current `E_*` mapping), `smtp`
(`cloudflare:sockets`, STARTTLS or implicit TLS, credentials as Worker secrets), `ses` (SigV4-signed
raw send), `resend` (its HTTP API). Each maps the provider's rejections onto the same
`sender_not_verified`, `too_many_requests` and `message_rejected` errors, so `src/core` and the
adapters do not change. Selected by a `MAIL_TRANSPORT` var, default `cloudflare`. The OTP mail in
`src/email/system.ts` goes through the same transport.

Inbound. `ingestInbound` already takes `{envelopeFrom, envelopeTo, raw}` and knows nothing about
Email Routing; the `email()` handler is one adapter over it. Add a second, `POST /v1/inbound`,
authenticated by an `INBOUND_SECRET` var and accepting the envelope fields plus raw MIME, which
SES via SNS or S3, Resend inbound webhooks, or a self-hosted MTA can call. Rejections return the
same `550` and `552` reasons in the response body so the caller can bounce.

`pnpm run setup` skips the Email Routing and Email Sending steps when the transport is not
`cloudflare` and instead checks that the chosen provider's secrets are set. Drafts drain
through the transport. The test suites' `EMAIL` fake becomes a `MailTransport` fake.

## 4. Suppression list and bounce handling

Parse the bounce traffic arriving on the `cf-bounce` MX and maintain a per-account suppression list.
Sends to a suppressed address fail fast with a clear error instead of burning quota. Transports
from item 3 feed the same list from their own bounce notifications: SES over SNS, Resend over
its webhooks, SMTP from DSN mail arriving at the inbound adapter.

## 5. Per-inbox Durable Object

Replace `wait_for_message`'s D1 polling with a push-style wait backed by a Durable Object per inbox.
Lower latency and no polling cost; the D1 path stays as the fallback.

## 6. OAuth for MCP clients

Authorization-code flow for MCP clients that cannot set static headers, issuing tokens that map to
the same API-key records.

## 7. Spam scoring and virus scanning on inbound

Score inbound mail and label or reject accordingly, so an agent is not handed obvious junk.

## 8. Deliverability visibility as MCP tools

Expose what an agent currently cannot see about its own sending: the DMARC aggregate reports for
the mail domain, a reputation summary derived from them and from bounce traffic, and the
suppression list from item 4. Read-only tools alongside the existing ones, so an agent can find out
that its mail is being rejected without an operator reading a dashboard for it.
