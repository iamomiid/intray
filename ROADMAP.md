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


Endpoint reference for the work. All are `GET`, and each answered to the wrangler OAuth token and
to an account token:

- `/accounts/{account}/email/sending/suppressions` takes `cursor`, `per_page`, `reason` and
  `email`, and returns items `{id, email, reason, created_at, expires_at, note, read_only}` with
  `reason` values such as `hard_bounce`. The same path takes `POST`, `PATCH` and `DELETE`, and
  `/bulk` imports; the mirror needs only the read.
- `/accounts/{account}/email/sending/messages/{message_id}` returns the delivery status of one sent
  message. Its response fields, and which values mean a failure, are not recorded; capture them
  from a real failed send before writing the `bounced` mapping.
- `/accounts/{account}/email/sending/reputation` and `/accounts/{account}/email/sending/limits`
  answer. Their response shapes are not recorded.
- `/zones/{zone}/email/sending/subdomains/{id}/reputation/complaints` holds the per-domain
  complaint counts. Its response shape is not recorded.
- A sending domain object carries `return_path_domain`, `dkim_selector` and
  `drop_suppressed_recipients`; the return path signs with the `cf-bounce` selector.

Untested: whether a send to a recipient domain with no MX ever produces a suppression entry. One
such send left the list empty after six minutes, which means either slow bounce processing on
Cloudflare's side or no entry for that case. The sync must not assume every failed send shows up
in the list.
