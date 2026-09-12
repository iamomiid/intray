#!/usr/bin/env bash
set -euo pipefail

allowed_hosts='(example\.(com|org|net)|[a-z0-9.-]+\.example\.(com|org|net)|[a-z0-9.-]+\.(example|test|invalid|localhost)|localhost)'

emails=$(git grep -niIE '[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}' -- ':!pnpm-lock.yaml' \
  | grep -viE "[A-Za-z0-9._%+-]+@${allowed_hosts}(\.?[^A-Za-z0-9.-]|\.?$)" \
  | grep -vE 'noreply@anthropic\.com|@(cloudflare|modelcontextprotocol|biomejs|types)/' || true)

urls=$(git grep -nIE '[a-z0-9-]+\.[a-z0-9-]+\.workers\.dev' -- ':!pnpm-lock.yaml' \
  | grep -vE '[a-z0-9-]+\.(example|x)\.workers\.dev' || true)

ids=$(git grep -nIE '\b[0-9a-f]{32}\b|\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b' -- ':!pnpm-lock.yaml' || true)

failed=0
report() {
  if [ -n "$2" ]; then
    failed=1
    printf '%s\n%s\n\n' "$1" "$2"
  fi
}
report "email addresses outside the example, test, invalid and localhost domains:" "$emails"
report "workers.dev URLs that are not intray.example.workers.dev:" "$urls"
report "32-hex or UUID identifiers, which look like account, zone or database ids:" "$ids"

if [ "$failed" -ne 0 ]; then
  echo "use the placeholders from AGENTS.md: example.com, agents.example.com, you@example.com, https://intray.example.workers.dev"
  exit 1
fi
echo "no forbidden identifiers"
