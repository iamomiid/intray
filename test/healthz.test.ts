import { SELF } from "cloudflare:test";
import { expect, it } from "vitest";

it("returns ok from /healthz", async () => {
  const response = await SELF.fetch("http://intray.test/healthz");
  expect(response.status).toBe(200);
  await expect(response.json()).resolves.toEqual({ ok: true });
});

it("serves /skill.md as markdown", async () => {
  const response = await SELF.fetch("http://intray.test/skill.md");
  expect(response.status).toBe(200);
  expect(response.headers.get("content-type")).toContain("text/markdown");
  await expect(response.text()).resolves.toContain("intray");
});
