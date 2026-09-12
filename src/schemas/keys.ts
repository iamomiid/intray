import { z } from "zod";
import { keyId } from "./common";

export const createApiKeyBody = z.object({
  name: z.string().optional(),
  scopes: z.array(z.string()).optional(),
});

export const createApiKeyInput = createApiKeyBody;

export const keyParams = z.object({ key_id: keyId });
