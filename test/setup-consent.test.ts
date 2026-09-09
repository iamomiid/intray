import { describe, expect, it } from "vitest";
import type { Change, ConsentContext, ConsentIo } from "../scripts/lib/consent.ts";
import { approveChange } from "../scripts/lib/consent.ts";
import { SetupError } from "../scripts/lib/errors.ts";

interface Recorder extends ConsentIo {
  written: string[];
}

function recorder(interactive: boolean, answers: string[]): Recorder {
  const written: string[] = [];
  return {
    written,
    interactive: () => interactive,
    write: (text: string) => {
      written.push(text);
    },
    readLine: () => answers.shift() ?? "",
  };
}

function context(acceptChanges: boolean, io: ConsentIo): ConsentContext {
  return { args: { acceptChanges }, consent: io };
}

const CHANGE: Change = {
  step: "Email Routing",
  title: "Enable Email Routing on example.com.",
  details: ["MX  example.com  route1.mx.cloudflare.net  priority 10", "TXT  example.com  v=spf1"],
  reversible: false,
};

describe("approveChange", () => {
  it("resolves on y at a terminal and shows the title, details and reversibility", async () => {
    const io = recorder(true, ["y"]);
    await expect(approveChange(context(false, io), CHANGE)).resolves.toBeUndefined();
    const output = io.written.join("");
    expect(output).toContain("Enable Email Routing on example.com.");
    expect(output).toContain("      MX  example.com  route1.mx.cloudflare.net  priority 10");
    expect(output).toContain("      TXT  example.com  v=spf1");
    expect(output).toContain("reversible: no");
    expect(output).toContain("Apply this change? [y/N] ");
  });

  it("accepts the long yes", async () => {
    const io = recorder(true, ["yes"]);
    await expect(approveChange(context(false, io), CHANGE)).resolves.toBeUndefined();
  });

  it("throws declined on n at a terminal", async () => {
    const io = recorder(true, ["n"]);
    await expect(approveChange(context(false, io), CHANGE)).rejects.toThrow("declined");
    await expect(approveChange(context(false, recorder(true, [""])), CHANGE)).rejects.toThrow(
      "declined",
    );
  });

  it("names the step on the thrown error", async () => {
    const io = recorder(true, ["n"]);
    const error = await approveChange(context(false, io), CHANGE).catch(
      (reason: unknown) => reason,
    );
    expect(error).toBeInstanceOf(SetupError);
    expect((error as SetupError).step).toBe("Email Routing");
  });

  it("throws with the details when there is no terminal and no flag", async () => {
    const io = recorder(false, []);
    const error = await approveChange(context(false, io), CHANGE).catch(
      (reason: unknown) => reason,
    );
    expect(error).toBeInstanceOf(SetupError);
    const message = (error as SetupError).message;
    expect(message).toContain(
      "this change needs approval. Run the setup in a terminal, or pass --accept-changes after reviewing:",
    );
    expect(message).toContain("Enable Email Routing on example.com.");
    expect(message).toContain("MX  example.com  route1.mx.cloudflare.net  priority 10");
    expect(message).toContain("reversible: no");
    expect(io.written).toEqual([]);
  });

  it("resolves without prompting when --accept-changes is set", async () => {
    const io = recorder(false, []);
    await expect(approveChange(context(true, io), CHANGE)).resolves.toBeUndefined();
    const output = io.written.join("");
    expect(output).toContain("accepted (--accept-changes)");
    expect(output).toContain("Enable Email Routing on example.com.");
    expect(output).not.toContain("Apply this change?");
  });

  it("prints reversible: yes for a change that can be undone", async () => {
    const io = recorder(true, ["y"]);
    await approveChange(context(false, io), { ...CHANGE, reversible: true });
    expect(io.written.join("")).toContain("reversible: yes");
  });
});
