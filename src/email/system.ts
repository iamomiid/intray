import { config, type Env } from "../env";
import { AppError } from "../lib/errors";
import { buildSend, send } from "./outbound";

export interface OtpEmailInput {
  to: string;
  code: string;
}

function senderDomain(env: Env): string {
  const [primary] = config(env).domains;
  if (primary === undefined) {
    throw new AppError(500, "internal_error", "no mail domains configured");
  }
  return primary;
}

function otpText(code: string): string {
  return [
    `${code} is your intray verification code.`,
    "",
    "It is valid for 10 minutes.",
    "",
    "Give this code to the agent that asked you for it.",
    "",
  ].join("\n");
}

function otpHtml(code: string): string {
  return [
    `<p><strong>${code}</strong> is your intray verification code.</p>`,
    "<p>It is valid for 10 minutes.</p>",
    "<p>Give this code to the agent that asked you for it.</p>",
  ].join("");
}

export async function sendOtpEmail(env: Env, input: OtpEmailInput): Promise<void> {
  const built = buildSend({
    from: { name: "intray", email: `noreply@${senderDomain(env)}` },
    to: input.to,
    subject: `${input.code} is your intray verification code`,
    text: otpText(input.code),
    html: otpHtml(input.code),
  });
  await send(env, built.message);
}
