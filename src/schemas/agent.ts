import { z } from "zod";

export const signupBody = z.object({
  email: z.string(),
  username: z.string().optional(),
});

export const signupInput = signupBody;

export const verifyBody = z.object({
  code: z.string(),
});

export const verifyInput = z.object({
  api_key: z.string(),
  code: z.string(),
});

export const emptyInput = z.object({});
