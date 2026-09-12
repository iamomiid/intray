# Roadmap

Ordered. Each item is additive.

## 1. Cloudflare Email Sending feedback

On the `cloudflare` transport, outbound mail carries its return path on `cf-bounce.<domain>`, whose
MX points at Cloudflare, so bounces are processed there and never reach an inbox; the DSN path
only sees bounces on the `smtp` transport or from servers that reply to the visible sender. Read
Cloudflare's own records instead: mirror the account suppression list
(`GET /accounts/{account}/email/sending/suppressions`, cursor paginated, entries with `reason` and
`expires_at`) into `suppressions` with source `provider` on a schedule from the existing cron;
mark outbound rows from the per-message status endpoint
(`GET /accounts/{account}/email/sending/messages/{message_id}`) with a `bounced` label when
Cloudflare reports a failure; and feed `get_deliverability` from the account reputation endpoint
and the per-domain complaint counts. Needs an API token with Email Sending read as a Worker secret,
alongside `ROUTING_API_TOKEN`. Until this lands, the suppression list on the default transport is
fed only by manual entries and the deliverability summary reports zero bounces.

