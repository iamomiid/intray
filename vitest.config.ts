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
          PUBLIC_URL: "http://localhost:8787",
          ALLOWED_SIGNUP_EMAILS: "",
          OPERATOR_TOKEN: "op_test_0123456789abcdef0123456789abcdef",
        },
      },
    }),
  ],
  test: {
    setupFiles: ["./test/setup.ts"],
    exclude: [...configDefaults.exclude, "**/.claude/**"],
  },
});
