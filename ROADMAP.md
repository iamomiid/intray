# Roadmap

Ordered. Each item is additive; v1 data model already reserves the columns the early items need.

## 1. Custom domains per account

Register an account-owned domain through the Cloudflare API: run sending-domain onboarding and
route inbound through the per-inbox Email Routing rules, one rule per inbox on the account's
domain. Adds `domains(domain, account_id, verified_at)` and drops the reliance on a single
operator-wide `MAIL_DOMAINS`.

## 2. Pluggable mail providers

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

## 3. Deliverability visibility as MCP tools

Expose what an agent currently cannot see about its own sending: the DMARC aggregate reports for
the mail domain, a reputation summary derived from them and from bounce traffic, and the
suppression list. Read-only tools alongside the existing ones, so an agent can find out
that its mail is being rejected without an operator reading a dashboard for it.
