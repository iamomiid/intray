import { describe, expect, it } from "vitest";
import {
  parseAccountId,
  parseArgs,
  parseBucketNames,
  parseD1Databases,
  parseD1Rows,
  parseDatabaseId,
  parseDeployUrl,
  parseEnvFile,
  parseJsonPayload,
  parseSecretNames,
  parseWranglerConfig,
  workersDevUrl,
  zoneCandidates,
} from "../scripts/lib/parse.ts";

const WRANGLER_CONFIG = `oauth_token = "SdCh-oauth-token-value"
refresh_token = "not-the-token"
expiration_time = "2026-09-09T12:00:00.000Z"
scopes = [
  "account:read",
  "user:read",
  "workers:write",
  "d1:write",
  "zone:read",
  "email_routing:write",
  "email_sending:write"
]
`;

describe("parseArgs", () => {
  it("reads the domain and lowercases it", () => {
    const args = parseArgs(["--domain", "Example.COM"]);
    expect(args.errors).toEqual([]);
    expect(args.domain).toBe("example.com");
    expect(args.email).toBe("");
    expect(args.yes).toBe(false);
  });

  it("accepts the equals form and every flag", () => {
    const args = parseArgs(["--domain=example.com", "--email=Operator@Example.com", "--yes"]);
    expect(args.errors).toEqual([]);
    expect(args.email).toBe("operator@example.com");
    expect(args.yes).toBe(true);
  });

  it("requires a domain", () => {
    expect(parseArgs([]).errors).toEqual(["--domain is required"]);
  });

  it("rejects a value that is not a domain", () => {
    expect(parseArgs(["--domain", "not a domain"]).errors).toEqual([
      "not a domain name: not a domain",
    ]);
  });

  it("rejects a value that is not an email address", () => {
    expect(parseArgs(["--domain", "example.com", "--email", "nope"]).errors).toEqual([
      "not an email address: nope",
    ]);
  });

  it("rejects unknown arguments and missing values", () => {
    expect(parseArgs(["--domain", "example.com", "--wat"]).errors).toEqual([
      "unknown argument: --wat",
    ]);
    expect(parseArgs(["--domain"]).errors).toEqual([
      "--domain requires a value",
      "--domain is required",
    ]);
  });

  it("generates an operator token when the flag carries no value", () => {
    expect(parseArgs(["--domain", "example.com", "--operator-token"]).operatorToken).toBe(
      "generate",
    );
    expect(parseArgs(["--domain", "example.com", "--operator-token", "--yes"]).operatorToken).toBe(
      "generate",
    );
    expect(parseArgs(["--domain", "example.com"]).operatorToken).toBe("");
  });

  it("keeps an explicit operator token", () => {
    const value = "op_0123456789abcdef0123456789abcdef";
    const args = parseArgs(["--domain", "example.com", "--operator-token", value]);
    expect(args.errors).toEqual([]);
    expect(args.operatorToken).toBe(value);
    expect(parseArgs([`--domain=example.com`, `--operator-token=${value}`]).operatorToken).toBe(
      value,
    );
  });

  it("rejects an operator token shorter than 32 characters", () => {
    expect(parseArgs(["--domain", "example.com", "--operator-token", "op_short"]).errors).toEqual([
      "--operator-token must be at least 32 characters",
    ]);
  });

  it("reads the transport flag", () => {
    expect(parseArgs(["--domain", "example.com"]).transport).toBe("");
    expect(parseArgs(["--domain", "example.com", "--transport", "SES"]).transport).toBe("ses");
    expect(parseArgs(["--domain=example.com", "--transport=resend"]).transport).toBe("resend");
    expect(parseArgs(["--domain", "example.com", "--transport", "postal"]).errors).toEqual([
      "--transport must be one of cloudflare, smtp, ses, resend: postal",
    ]);
  });

  it("reads the dmarc reports flag", () => {
    expect(parseArgs(["--domain", "example.com"]).dmarcReports).toBe(false);
    const args = parseArgs(["--domain", "example.com", "--dmarc-reports"]);
    expect(args.errors).toEqual([]);
    expect(args.dmarcReports).toBe(true);
  });

  it("takes the dmarc reports flag as the value-less end of --operator-token", () => {
    const args = parseArgs(["--domain", "example.com", "--operator-token", "--dmarc-reports"]);
    expect(args.errors).toEqual([]);
    expect(args.operatorToken).toBe("generate");
    expect(args.dmarcReports).toBe(true);
  });

  it("reads the accept changes flag", () => {
    expect(parseArgs(["--domain", "example.com"]).acceptChanges).toBe(false);
    const args = parseArgs(["--domain", "example.com", "--accept-changes"]);
    expect(args.errors).toEqual([]);
    expect(args.acceptChanges).toBe(true);
    expect(args.yes).toBe(false);
  });

  it("keeps --yes and --accept-changes separate", () => {
    const args = parseArgs(["--domain", "example.com", "--yes"]);
    expect(args.yes).toBe(true);
    expect(args.acceptChanges).toBe(false);
  });

  it("takes the accept changes flag as the value-less end of --operator-token", () => {
    const args = parseArgs(["--domain", "example.com", "--operator-token", "--accept-changes"]);
    expect(args.errors).toEqual([]);
    expect(args.operatorToken).toBe("generate");
    expect(args.acceptChanges).toBe(true);
  });

  it("accepts a subdomain as the mail domain", () => {
    const args = parseArgs(["--domain", "Agents.Example.com"]);
    expect(args.errors).toEqual([]);
    expect(args.domain).toBe("agents.example.com");
  });

  it("short-circuits on help without demanding a domain", () => {
    const args = parseArgs(["--help"]);
    expect(args.help).toBe(true);
    expect(args.errors).toEqual([]);
  });
});

describe("parseArgs routing", () => {
  it("defaults to leaving the current mode alone", () => {
    expect(parseArgs(["--domain", "example.com"]).routing).toBe("");
  });

  it("reads both modes in either form", () => {
    expect(parseArgs(["--domain", "example.com", "--routing", "per_inbox"]).routing).toBe(
      "per_inbox",
    );
    expect(parseArgs(["--domain=example.com", "--routing=Catch_All"]).routing).toBe("catch_all");
  });

  it("rejects any other value", () => {
    expect(parseArgs(["--domain", "example.com", "--routing", "sometimes"]).errors).toEqual([
      "--routing must be catch_all or per_inbox: sometimes",
    ]);
  });

  it("requires a value", () => {
    expect(parseArgs(["--domain", "example.com", "--routing"]).errors).toEqual([
      "--routing requires a value",
    ]);
  });
});

describe("parseD1Rows", () => {
  it("reads the rows out of a wrangler d1 execute --json payload", () => {
    const output = `Executing on remote database\n${JSON.stringify([
      { results: [{ inbox_id: "one@example.com", routing_rule_id: null }], success: true },
    ])}`;

    expect(parseD1Rows(output)).toEqual([{ inbox_id: "one@example.com", routing_rule_id: null }]);
  });

  it("answers with no rows for output it cannot read", () => {
    expect(parseD1Rows("no json here")).toEqual([]);
    expect(parseD1Rows(JSON.stringify([{ success: true }]))).toEqual([]);
  });
});

describe("zoneCandidates", () => {
  it("strips one leading label at a time", () => {
    expect(zoneCandidates("a.b.example.com")).toEqual([
      "a.b.example.com",
      "b.example.com",
      "example.com",
    ]);
  });

  it("returns the apex alone for an apex domain", () => {
    expect(zoneCandidates("example.com")).toEqual(["example.com"]);
  });

  it("puts the given name first for a single subdomain", () => {
    expect(zoneCandidates("agents.example.com")).toEqual(["agents.example.com", "example.com"]);
  });

  it("handles a multi-part public suffix by trying every parent", () => {
    expect(zoneCandidates("agents.example.co.uk")).toEqual([
      "agents.example.co.uk",
      "example.co.uk",
      "co.uk",
    ]);
  });

  it("returns the input when there is nothing to strip", () => {
    expect(zoneCandidates("localhost")).toEqual(["localhost"]);
  });
});

describe("parseEnvFile", () => {
  it("reads pairs and ignores comments, blanks and junk", () => {
    const values = parseEnvFile(
      [
        "# a comment",
        "",
        "CLOUDFLARE_API_TOKEN=abc123",
        'QUOTED="with spaces"',
        "SINGLE='single'",
        "export EXPORTED=yes",
        "TRAILING=value # not part of it",
        "no-equals-here",
        "1BAD=nope",
      ].join("\n"),
    );
    expect(values).toEqual({
      CLOUDFLARE_API_TOKEN: "abc123",
      QUOTED: "with spaces",
      SINGLE: "single",
      EXPORTED: "yes",
      TRAILING: "value",
    });
  });

  it("keeps a hash inside a quoted value", () => {
    expect(parseEnvFile('TOKEN="a#b"').TOKEN).toBe("a#b");
  });

  it("returns nothing for an empty file", () => {
    expect(parseEnvFile("")).toEqual({});
  });
});

describe("parseWranglerConfig", () => {
  it("reads the oauth token, expiry and a multi-line scopes array", () => {
    const login = parseWranglerConfig(WRANGLER_CONFIG);
    expect(login.oauthToken).toBe("SdCh-oauth-token-value");
    expect(login.expirationTime).toBe("2026-09-09T12:00:00.000Z");
    expect(login.scopes).toEqual([
      "account:read",
      "user:read",
      "workers:write",
      "d1:write",
      "zone:read",
      "email_routing:write",
      "email_sending:write",
    ]);
  });

  it("reads a single-line scopes array", () => {
    const login = parseWranglerConfig(
      'oauth_token = "abc"\nscopes = [ "zone:read", "email_sending:write" ]\n',
    );
    expect(login.oauthToken).toBe("abc");
    expect(login.expirationTime).toBe("");
    expect(login.scopes).toEqual(["zone:read", "email_sending:write"]);
  });

  it("returns empties when the file has no oauth token", () => {
    expect(parseWranglerConfig("")).toEqual({
      oauthToken: "",
      expirationTime: "",
      scopes: [],
    });
    expect(parseWranglerConfig('api_token = "not-oauth"').oauthToken).toBe("");
  });
});

describe("parseAccountId", () => {
  it("finds the account id in a whoami table", () => {
    const output = [
      " ⛅️ wrangler 4.129.1",
      "Getting User settings...",
      "👋 You are logged in with an OAuth Token, associated with the email operator@example.com.",
      "┌──────────────────────┬──────────────────────────────────┐",
      "│ Account Name         │ Account ID                       │",
      "├──────────────────────┼──────────────────────────────────┤",
      "│ Example Account      │ 0123456789abcdef0123456789abcdef │",
      "└──────────────────────┴──────────────────────────────────┘",
    ].join("\n");
    expect(parseAccountId(output)).toBe("0123456789abcdef0123456789abcdef");
  });

  it("returns null when not logged in", () => {
    expect(parseAccountId("You are not authenticated. Please run `wrangler login`.")).toBeNull();
  });
});

describe("parseDatabaseId", () => {
  it("finds the uuid printed by d1 create", () => {
    const output = [
      "✅ Successfully created DB 'intray' in region WEUR",
      "Created your new D1 database.",
      "[[d1_databases]]",
      'binding = "DB"',
      'database_name = "intray"',
      'database_id = "0f6a1c2e-8b3d-4e5f-9a7b-1c2d3e4f5a6b"',
    ].join("\n");
    expect(parseDatabaseId(output)).toBe("0f6a1c2e-8b3d-4e5f-9a7b-1c2d3e4f5a6b");
  });

  it("returns null when there is no uuid", () => {
    expect(parseDatabaseId("nothing to see")).toBeNull();
  });
});

describe("parseD1Databases", () => {
  it("reads name and uuid out of d1 list --json", () => {
    const output = `
 ⛅️ wrangler 4.129.1
[
  { "uuid": "0f6a1c2e-8b3d-4e5f-9a7b-1c2d3e4f5a6b", "name": "intray", "version": "production" },
  { "uuid": "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee", "name": "other" }
]
`;
    expect(parseD1Databases(output)).toEqual([
      { name: "intray", uuid: "0f6a1c2e-8b3d-4e5f-9a7b-1c2d3e4f5a6b" },
      { name: "other", uuid: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee" },
    ]);
  });

  it("returns nothing for an empty account or unparseable output", () => {
    expect(parseD1Databases("[]")).toEqual([]);
    expect(parseD1Databases("boom")).toEqual([]);
  });
});

describe("parseBucketNames", () => {
  it("reads the name lines", () => {
    const output = [
      "Listing buckets...",
      "name:           intray",
      "creation_date:  2026-09-08T12:00:00.000Z",
      "",
      "name:           other",
      "creation_date:  2026-09-08T12:00:00.000Z",
    ].join("\n");
    expect(parseBucketNames(output)).toEqual(["intray", "other"]);
  });

  it("returns nothing when there are no buckets", () => {
    expect(parseBucketNames("Listing buckets...")).toEqual([]);
  });
});

describe("parseSecretNames", () => {
  it("reads the names out of secret list --format json", () => {
    const output = `
 ⛅️ wrangler 4.129.1
[
  { "name": "OPERATOR_TOKEN", "type": "secret_text" },
  { "name": "OTHER", "type": "secret_text" }
]
`;
    expect(parseSecretNames(output)).toEqual(["OPERATOR_TOKEN", "OTHER"]);
  });

  it("returns nothing when the output is not json", () => {
    expect(parseSecretNames("Secret Name: OPERATOR_TOKEN")).toEqual([]);
  });

  it("returns nothing for a worker with no secrets", () => {
    expect(parseSecretNames("[]")).toEqual([]);
    expect(parseSecretNames("No secrets found.")).toEqual([]);
  });
});

describe("parseDeployUrl", () => {
  it("picks the workers.dev URL out of deploy output", () => {
    const output = [
      "Total Upload: 512.00 KiB / gzip: 128.00 KiB",
      "Uploaded intray (3.21 sec)",
      "Deployed intray triggers (1.02 sec)",
      "  https://intray.example.workers.dev",
      "Current Version ID: 0f4a1b2c-1111-2222-3333-444455556666",
    ].join("\n");
    expect(parseDeployUrl(output)).toBe("https://intray.example.workers.dev");
  });

  it("ignores unrelated https links and trailing punctuation", () => {
    const output =
      "See https://developers.cloudflare.com/workers/.\n  https://intray.x.workers.dev/";
    expect(parseDeployUrl(output)).toBe("https://intray.x.workers.dev");
  });

  it("returns null when no workers.dev URL was printed", () => {
    expect(parseDeployUrl("Deployed intray triggers")).toBeNull();
  });
});

describe("parseJsonPayload", () => {
  it("skips a preamble before the payload", () => {
    expect(parseJsonPayload('noise\n{"a":1}\n')).toEqual({ a: 1 });
  });

  it("returns null for broken json", () => {
    expect(parseJsonPayload("{oops")).toBeNull();
    expect(parseJsonPayload("no payload")).toBeNull();
  });
});

describe("workersDevUrl", () => {
  it("builds the workers.dev URL", () => {
    expect(workersDevUrl("intray", "example")).toBe("https://intray.example.workers.dev");
  });
});
