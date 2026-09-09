import type { Context, MiddlewareHandler } from "hono";
import { type AuthenticateOptions, authenticate } from "../core/keys";
import { unauthorized } from "../lib/errors";
import type { AppEnv } from "./types";

const BEARER = /^bearer\s+(.+)$/i;

function readKey(c: Context<AppEnv>): string | null {
  const authorization = c.req.header("authorization");
  if (authorization !== undefined) {
    const match = BEARER.exec(authorization.trim());
    if (match !== null) {
      return match[1] ?? null;
    }
  }
  return c.req.header("x-api-key") ?? null;
}

function authGuard(options: AuthenticateOptions): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const principal = await authenticate(c.env, readKey(c), options);
    if (principal === null) {
      throw unauthorized("invalid api key");
    }
    c.set("principal", principal);
    await next();
  };
}

export const requireAuth: MiddlewareHandler<AppEnv> = authGuard({});

export const requirePendingAuth: MiddlewareHandler<AppEnv> = authGuard({ allowPending: true });
