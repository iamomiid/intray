import { describe, expect, it } from "vitest";
import type { DnsRecord, DnsStatus } from "../scripts/lib/dns.ts";
import {
  dnsErrors,
  formatRecords,
  hasForeignMx,
  RECORD_VALUE_LIMIT,
  statusRecords,
} from "../scripts/lib/dns.ts";

const MX: DnsRecord = {
  type: "MX",
  name: "agents.example.com",
  content: "route1.mx.cloudflare.net",
  priority: 10,
};

const DKIM_VALUE = `v=DKIM1; h=sha256; k=rsa; p=${"A".repeat(392)}`;

describe("formatRecords", () => {
  it("renders type, name, content and priority", () => {
    expect(formatRecords([MX], "none")).toEqual([
      "MX  agents.example.com  route1.mx.cloudflare.net  priority 10",
    ]);
  });

  it("drops records repeated by type, name and content", () => {
    const lines = formatRecords(
      [MX, { ...MX }, { ...MX, content: "route2.mx.cloudflare.net" }],
      "none",
    );
    expect(lines).toEqual([
      "MX  agents.example.com  route1.mx.cloudflare.net  priority 10",
      "MX  agents.example.com  route2.mx.cloudflare.net  priority 10",
    ]);
  });

  it("keeps records that differ only in type or name", () => {
    expect(
      formatRecords(
        [
          { type: "TXT", name: "a.example.com", content: "v=spf1" },
          { type: "TXT", name: "b.example.com", content: "v=spf1" },
          { type: "SPF", name: "a.example.com", content: "v=spf1" },
        ],
        "none",
      ),
    ).toHaveLength(3);
  });

  it("truncates a long TXT value but keeps the name and type", () => {
    const line = formatRecords(
      [{ type: "TXT", name: "cf2024._domainkey.example.com", content: DKIM_VALUE }],
      "none",
    )[0];
    expect(line).toBeDefined();
    const value = (line ?? "").split("  ")[2] ?? "";
    expect(line).toContain("TXT  cf2024._domainkey.example.com  ");
    expect(value).toHaveLength(RECORD_VALUE_LIMIT);
    expect(value.endsWith("…")).toBe(true);
    expect(value.startsWith("v=DKIM1; h=sha256; k=rsa; p=")).toBe(true);
    expect(line).not.toContain(DKIM_VALUE);
  });

  it("leaves a value of exactly the limit alone", () => {
    const content = "x".repeat(RECORD_VALUE_LIMIT);
    expect(formatRecords([{ type: "TXT", name: "example.com", content }], "none")).toEqual([
      `TXT  example.com  ${content}`,
    ]);
  });

  it("uses the fallback when there is nothing to show", () => {
    expect(formatRecords([], "no records")).toEqual(["no records"]);
  });
});

describe("statusRecords", () => {
  it("collects missing, records, record and the records carried by errors once", () => {
    const status: DnsStatus = {
      missing: [MX],
      records: [MX, { type: "TXT", name: "example.com", content: "v=spf1 include:_spf.mx" }],
      record: [MX],
      errors: [{ code: "dns.mx.missing", missing: MX }],
    };
    expect(statusRecords(status)).toHaveLength(5);
    expect(formatRecords(statusRecords(status), "none")).toEqual([
      "MX  agents.example.com  route1.mx.cloudflare.net  priority 10",
      "TXT  example.com  v=spf1 include:_spf.mx",
    ]);
  });

  it("returns nothing for an empty or absent status", () => {
    expect(statusRecords(null)).toEqual([]);
    expect(statusRecords({})).toEqual([]);
  });
});

describe("dnsErrors", () => {
  it("reads strings, codes, messages and missing records", () => {
    expect(
      dnsErrors({
        errors: [
          "plain failure",
          { code: 1004, message: "record missing" },
          { code: "dns.mx.foreign" },
          { message: "unverified" },
          { code: "dns.mx.missing", missing: MX },
        ],
      }),
    ).toEqual([
      "plain failure",
      "1004: record missing",
      "dns.mx.foreign",
      "unverified",
      "dns.mx.missing MX  agents.example.com  route1.mx.cloudflare.net  priority 10",
    ]);
  });

  it("returns nothing when the status is clean", () => {
    expect(dnsErrors(null)).toEqual([]);
    expect(dnsErrors({ errors: [] })).toEqual([]);
  });
});

describe("hasForeignMx", () => {
  it("spots the foreign MX code and message", () => {
    expect(hasForeignMx({ errors: [{ code: "dns.mx.foreign" }] })).toBe(true);
    expect(hasForeignMx({ errors: [{ message: "dns.mx.foreign records found" }] })).toBe(true);
    expect(hasForeignMx({ errors: [{ code: "dns.mx.missing" }] })).toBe(false);
    expect(hasForeignMx(null)).toBe(false);
  });
});
