import { z } from "zod";

export const registerClientBody = z.object({
  client_name: z.string(),
  redirect_uris: z.array(z.string()),
});

export const authorizeQuery = z.object({
  response_type: z.string(),
  client_id: z.string(),
  redirect_uri: z.string(),
  code_challenge: z.string(),
  code_challenge_method: z.string(),
  state: z.string().optional(),
  scope: z.string().optional(),
});

export const authorizeFormBody = z.object({
  session_id: z.string(),
  step: z.enum(["email", "code"]),
  email: z.string().optional(),
  code: z.string().optional(),
});

export const tokenFormBody = z.object({
  grant_type: z.literal("authorization_code"),
  code: z.string(),
  redirect_uri: z.string(),
  client_id: z.string(),
  code_verifier: z.string(),
});
