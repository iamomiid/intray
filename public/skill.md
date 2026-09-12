# intray

intray gives an AI agent real email inboxes: create an inbox, receive mail, read threads, reply,
wait for a message. The surface is a REST API under `/v1` and an MCP server at `/mcp`; the agent
onboards itself and holds the API key.

## Onboarding

**Operator token.** A personal deployment can skip signup entirely by using its operator token
instead.

- If you're a human reading this: `pnpm run setup --operator-token` prints a token starting with
  `op_` once. Give it to your agent instead of having it sign up.
- If you're an AI agent: if you were given a token starting with `op_`, send it as
  `Authorization: Bearer op_...` on every request, the same way an `it_` key is sent. It is already
  verified, so you may create inboxes, read mail, and send to anyone straight away. Do not call
  `signup` or `verify` with it.

Without an operator token, sign up with your human's email address. The response carries the API
key and the account's first inbox.

```sh
curl -sS -X POST <PUBLIC_URL>/v1/agent/signup \
  -H 'content-type: application/json' \
  -d '{"email":"you@example.com","username":"desk-agent"}'
```

```json
{ "api_key": "it_...", "inbox_id": "desk-agent@agents.example.com", "account_id": "acc_...", "verified": false, "key_pending": false }
```

Ask the human for the 6-digit code just mailed to that address. Ask for the code only; never ask
for a password.

```sh
curl -sS -X POST <PUBLIC_URL>/v1/agent/verify \
  -H 'content-type: application/json' \
  -H 'Authorization: Bearer it_...' \
  -d '{"code":"123456"}'
```

Store the key where your own configuration lives, not in a file you send to anyone. Send it on every
later request as `Authorization: Bearer it_...` or `X-API-Key: it_...`.

## Lost key

Sign up again with the same email address. The response carries `key_pending: true` and a key that
authenticates nowhere except `/v1/agent/verify`, and a fresh 6-digit code goes to that address. Ask
the human for the code and verify with the new key. At that moment the new key becomes active and
every other key on the account is revoked, so switch to it everywhere.

A re-signup disables nothing until that verify succeeds: the keys already in use keep working, no
inbox is created, and nothing is revoked. A wrong or expired code leaves the account exactly as it
was, which is why knowing the address is not enough to take the account over.

## Connect via MCP

```sh
claude mcp add --transport http intray <PUBLIC_URL>/mcp --header "Authorization: Bearer <key>"
```

Any client that speaks streamable HTTP works; the key rides in the header.

```json
{
  "mcpServers": {
    "intray": {
      "type": "http",
      "url": "<PUBLIC_URL>/mcp",
      "headers": { "Authorization": "Bearer <key>" }
    }
  }
}
```

Without a valid key the endpoint serves only `signup`, `verify`, and `read_onboarding_docs`. With
one, or with the operator token, it serves the full tool set. `inbox_id` is always the full email
address.

## Common tasks

Create an inbox:

```sh
curl -sS -X POST <PUBLIC_URL>/v1/inboxes \
  -H 'Authorization: Bearer it_...' -H 'content-type: application/json' \
  -d '{"username":"signups","display_name":"Desk Agent"}'
```

MCP: `create_inbox {"username":"signups","display_name":"Desk Agent"}`.

Always set `display_name`. It becomes the From name on everything the inbox sends, and a bare
`signups@agents.example.com` with no name behind it is treated as less trustworthy by receiving
servers and by the humans reading it.

Wait for a verification email and pull the code out of it. Note the current time first, trigger the
email, then block on the inbox. `wait_for_message` returns as soon as a message newer than `since`
lands, and returns an empty `items` array when the timeout expires.

```sh
curl -sS -G '<PUBLIC_URL>/v1/inboxes/signups%40agents.example.com/messages/wait' \
  -H 'Authorization: Bearer it_...' \
  --data-urlencode 'since=1757345000000' --data-urlencode 'timeout=55'
```

MCP: `wait_for_message {"inbox_id":"signups@agents.example.com","since":1757345000000,"timeout":55}`.
Read the code out of `items[0].text`; fall back to `items[0].html` when `text` is null.

Reply in the thread the message arrived in:

```sh
curl -sS -X POST '<PUBLIC_URL>/v1/inboxes/signups%40agents.example.com/messages/msg_.../reply' \
  -H 'Authorization: Bearer it_...' -H 'content-type: application/json' \
  -d '{"text":"Confirmed.","reply_all":true}'
```

MCP: `reply_to_message {"inbox_id":"...","message_id":"msg_...","text":"Confirmed."}`. It keeps the
thread, sets `In-Reply-To` and `References`, and prefixes `Re:` when needed.

Send a new message:

```sh
curl -sS -X POST '<PUBLIC_URL>/v1/inboxes/signups%40agents.example.com/messages/send' \
  -H 'Authorization: Bearer it_...' -H 'content-type: application/json' \
  -d '{"to":"you@example.com","subject":"Status","text":"Done."}'
```

MCP: `send_message {"inbox_id":"...","to":"you@example.com","subject":"Status","text":"Done."}`.

Use a `+tag` on the address when you want mail sorted for you. Anything sent to
`signups+alerts@agents.example.com` lands in the `signups@agents.example.com` inbox already
labelled `alerts`, so hand that address to a human or a service and then read the channel with
`list_messages {"inbox_id":"signups@agents.example.com","labels":"alerts"}`. It works in the other
direction too: pass `from` to `send_message` or `reply_to_message` to send as a subaddress of your
own inbox.

```sh
curl -sS -X POST '<PUBLIC_URL>/v1/inboxes/signups%40agents.example.com/messages/send' \
  -H 'Authorization: Bearer it_...' -H 'content-type: application/json' \
  -d '{"from":"signups+alerts@agents.example.com","to":"you@example.com","subject":"Status","text":"Done."}'
```

That message is stored with labels `["sent","alerts"]`, and because the recipient replies to the
address it came from, the reply arrives labelled `alerts` too. `from` must be your own inbox
address, with or without a tag; anything else is rejected.

Search an inbox:

```sh
curl -sS -G '<PUBLIC_URL>/v1/inboxes/signups%40agents.example.com/messages/search' \
  -H 'Authorization: Bearer it_...' --data-urlencode 'q=invoice'
```

MCP: `search_messages {"inbox_id":"...","q":"invoice"}`. `q` is plain words over subjects, bodies
and senders: every word must match, each matches by prefix, so `invoice` finds `invoices`, and the
best matches come first. Punctuation and words like `OR` are searched for literally. Use
`list_messages` with `labels`, `from`, `to`, `subject`, `since`, and `before` when you know what you
are filtering on.

## Limits and rules

- An unverified account may email only its own signup address. Anything else is `message_rejected`.
- A message must stay under 5 MiB in total, with at most 50 recipients across `to`, `cc`, and `bcc`
  and at most 32 attachments. Attachment `content` is base64.
- An account may hold a limited number of inboxes; creating one past the limit is `conflict`.
  Creating an address that already exists is `inbox_taken`.
- `wait` blocks at most 55 seconds and defaults to 30. `since` defaults to the moment of the call.
- Lists default to `limit=25` and cap at 100. Pass the previous `next_page_token` back as
  `page_token`; a `null` token means the end.
- Signup is rate-limited per IP, and codes are rate-limited per account. A deployment may also
  restrict signup to a fixed list of addresses; anything else is `signup_closed`.
- Timestamps are integer Unix milliseconds. Field names are snake_case. `:inbox_id` must be
  URL-encoded in a path.

## Errors

Every failure carries the same envelope. Over MCP it arrives as a tool error whose text is this
JSON.

```json
{ "error": { "code": "not_found", "message": "inbox not found" } }
```

| Status | Code |
| --- | --- |
| 400 | `bad_request`, `invalid_address`, `invalid_code` |
| 401 | `unauthorized` |
| 403 | `forbidden`, `message_rejected`, `signup_closed` |
| 404 | `not_found` |
| 409 | `conflict`, `inbox_taken` |
| 429 | `too_many_requests` |
| 500 | `internal_error` |
