import { z } from "zod";
import { pageArgs, suppressedAddress, suppressionReason } from "./common";

export const listSuppressionsQuery = z.object({
  reason: suppressionReason.optional(),
  ...pageArgs,
});

export const listSuppressionsInput = listSuppressionsQuery;

export const createSuppressionBody = z.object({
  address: z.string(),
  detail: z.string().optional(),
});

export const createSuppressionInput = createSuppressionBody;

export const suppressionParams = z.object({ address: suppressedAddress });

export const suppressionInput = suppressionParams;
