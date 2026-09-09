import { describe, expect, it } from "vitest";
import { steps } from "../scripts/lib/steps/index.ts";

const ORDER = [
  "Login",
  "Credentials",
  "D1 database",
  "R2 bucket",
  "Migrations",
  "Vars",
  "Deploy",
  "Operator token",
  "Zone",
  "Email Routing",
  "Email Sending",
  "DMARC reports",
  "Destination address",
  "Mail domain",
];

describe("steps", () => {
  it("runs in the documented order", () => {
    expect(steps.map((step) => step.name)).toEqual(ORDER);
  });

  it("writes the mail domain after the destination address", () => {
    expect(steps.map((step) => step.name).indexOf("Mail domain")).toBe(steps.length - 1);
  });

  it("names every step once", () => {
    expect(new Set(ORDER).size).toBe(ORDER.length);
  });
});
