import { expect, it } from "vitest";
import {
  isBlockedSignupDomain,
  isReservedUsername,
  isValidEmail,
  isValidUsername,
  normalizeAddress,
  parseAddress,
  randomUsername,
  splitAddress,
} from "../src/lib/address";
import { constantTimeEqual, generateApiKey, sha256Hex } from "../src/lib/hash";
import { clampLimit, decodeCursor, encodeCursor, page } from "../src/lib/pagination";
import { normalizeRfcMessageId, parseReferences } from "../src/lib/rfc";

it("parses display names and bare addresses", () => {
  expect(parseAddress('"Alice Example" <alice@example.com>')).toEqual({
    address: "alice@example.com",
    name: "Alice Example",
  });
  expect(parseAddress("Alice Example <alice@example.com>")).toEqual({
    address: "alice@example.com",
    name: "Alice Example",
  });
  expect(parseAddress("<alice@example.com>")).toEqual({
    address: "alice@example.com",
    name: null,
  });
  expect(parseAddress(" alice@example.com ")).toEqual({
    address: "alice@example.com",
    name: null,
  });
});

it("normalizes case and strips plus tags", () => {
  expect(normalizeAddress("  Agent+Newsletter@Intray.Example ")).toBe("agent@intray.example");
  expect(normalizeAddress("agent@intray.example")).toBe("agent@intray.example");
  expect(splitAddress("Agent@Intray.Example")).toEqual({
    username: "agent",
    domain: "intray.example",
  });
});

it("validates email addresses", () => {
  expect(isValidEmail("alice@example.com")).toBe(true);
  expect(isValidEmail("alice@example")).toBe(false);
  expect(isValidEmail("alice example.com")).toBe(false);
  expect(isValidEmail("")).toBe(false);
});

it("validates usernames and knows reserved and blocked values", () => {
  expect(isValidUsername("agent-01")).toBe(true);
  expect(isValidUsername("a.b_c-d")).toBe(true);
  expect(isValidUsername("ab")).toBe(false);
  expect(isValidUsername("-leading")).toBe(false);
  expect(isValidUsername("double..dot")).toBe(false);
  expect(isValidUsername("Upper")).toBe(false);
  expect(isReservedUsername("Postmaster")).toBe(true);
  expect(isReservedUsername("agent")).toBe(false);
  expect(isBlockedSignupDomain("example.com")).toBe(true);
  expect(isBlockedSignupDomain("intray.example")).toBe(false);
});

it("generates valid random usernames", () => {
  for (let index = 0; index < 20; index += 1) {
    const username = randomUsername();
    expect(isValidUsername(username)).toBe(true);
    expect(username).toMatch(/^[a-z]+-[a-z]+-\d{4}$/);
  }
});

it("round trips pagination cursors and clamps limits", () => {
  const token = encodeCursor({ at: 1757000000000, id: "msg_01hzz" });
  expect(decodeCursor(token)).toEqual({ at: 1757000000000, id: "msg_01hzz" });
  expect(token).not.toContain("=");
  expect(() => decodeCursor("not-a-cursor")).toThrowError("invalid page token");
  expect(() => decodeCursor(encodeCursor({ at: 1, id: "x" }).slice(0, 3))).toThrowError(
    "invalid page token",
  );

  expect(clampLimit(undefined)).toBe(25);
  expect(clampLimit("10")).toBe(10);
  expect(clampLimit("1000")).toBe(100);
  expect(clampLimit(-4)).toBe(25);
  expect(clampLimit("abc")).toBe(25);
});

it("emits a next page token only when more rows exist", () => {
  const rows = [
    { id: "a", at: 3 },
    { id: "b", at: 2 },
    { id: "c", at: 1 },
  ];
  const toCursor = (row: { id: string; at: number }) => ({ at: row.at, id: row.id });

  const full = page(rows, 3, toCursor);
  expect(full.next_page_token).toBeNull();
  expect(full.items).toHaveLength(3);

  const partial = page(rows, 2, toCursor);
  expect(partial.items.map((row) => row.id)).toEqual(["a", "b"]);
  expect(partial.next_page_token).not.toBeNull();
  expect(decodeCursor(partial.next_page_token ?? "")).toEqual({ at: 2, id: "b" });
});

it("normalizes rfc message ids to bare form", () => {
  expect(normalizeRfcMessageId("  <abc@example.com>  ")).toBe("abc@example.com");
  expect(normalizeRfcMessageId("abc@example.com")).toBe("abc@example.com");
  expect(normalizeRfcMessageId("<>")).toBeNull();
  expect(normalizeRfcMessageId("   ")).toBeNull();
  expect(normalizeRfcMessageId(null)).toBeNull();
  expect(normalizeRfcMessageId(undefined)).toBeNull();
  expect(parseReferences("<a@example.com>\r\n <b@example.com>")).toEqual([
    "a@example.com",
    "b@example.com",
  ]);
  expect(parseReferences(null)).toEqual([]);
});

it("generates prefixed api keys with a matching hash", async () => {
  const generated = await generateApiKey();
  expect(generated.key.startsWith("it_")).toBe(true);
  expect(generated.prefix).toBe(generated.key.slice(0, 10));
  expect(generated.hash).toHaveLength(64);
  expect(generated.hash).toBe(await sha256Hex(generated.key));
  expect(constantTimeEqual(generated.hash, generated.hash)).toBe(true);
  expect(constantTimeEqual(generated.hash, `${generated.hash}x`)).toBe(false);

  const other = await generateApiKey();
  expect(other.key).not.toBe(generated.key);
});
