import type { CallToolResult } from "@modelcontextprotocol/server";
import { AppError } from "../lib/errors";

export function jsonResult(value: unknown): CallToolResult {
  return { content: [{ type: "text", text: JSON.stringify(value) }] };
}

export function errorResult(error: unknown): CallToolResult {
  const failure =
    error instanceof AppError
      ? { code: error.code, message: error.message }
      : { code: "internal_error", message: "internal error" };
  return {
    isError: true,
    content: [{ type: "text", text: JSON.stringify({ error: failure }) }],
  };
}

export async function run(fn: () => Promise<unknown>): Promise<CallToolResult> {
  try {
    return jsonResult(await fn());
  } catch (error) {
    return errorResult(error);
  }
}
