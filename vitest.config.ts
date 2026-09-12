import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-pool-workers";
import { configDefaults, defineConfig } from "vitest/config";

const migrations = await readD1Migrations("migrations");

export default defineConfig({
  plugins: [
    cloudflareTest({
      remoteBindings: false,
      wrangler: { configPath: "./wrangler.jsonc" },
      miniflare: {
        compatibilityDate: "2026-08-22",
        bindings: {
          TEST_MIGRATIONS: migrations,
          MAIL_DOMAINS: "intray.example",
          INBOX_LIMIT: "10",
          DOMAIN_LIMIT: "5",
          PUBLIC_URL: "http://localhost:8787",
          ALLOWED_SIGNUP_EMAILS: "",
          QUOTA_MESSAGES_SENT_PER_MONTH: "100",
          QUOTA_MESSAGES_RECEIVED_PER_MONTH: "100",
          QUOTA_STORAGE_BYTES: "1073741824",
          SPAM_LABEL_THRESHOLD: "50",
          SPAM_REJECT_THRESHOLD: "90",
          ROUTING_MODE: "catch_all",
          MAIL_TRANSPORT: "cloudflare",
          CLOUDFLARE_ZONE_ID: "",
          ROUTING_API_TOKEN: "routing_test_token",
          WORKER_NAME: "intray",
          OPERATOR_TOKEN: "op_test_0123456789abcdef0123456789abcdef",
          ADMIN_SECRET: "admin_test_0123456789abcdef0123456789abcdef",
          INBOUND_SECRET: "inbound_test_secret_0000000000000000",
        },
      },
    }),
  ],
  test: {
    setupFiles: ["./test/setup.ts"],
    exclude: [...configDefaults.exclude, "**/.claude/**"],
  },
});
