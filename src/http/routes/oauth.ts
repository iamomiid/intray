import { Hono } from "hono";
import {
  type AuthorizeStep,
  authorizationServerMetadata,
  beginAuthorization,
  exchangeToken,
  protectedResourceMetadata,
  type RegisterClientInput,
  registerClient,
  submitAuthorizationCode,
  submitAuthorizationEmail,
} from "../../core/oauth";
import { readJson } from "../body";
import { codePage, emailPage, errorPage } from "../oauth-pages";
import type { AppEnv } from "../types";

export const wellKnownRoutes = new Hono<AppEnv>();

export const oauthRoutes = new Hono<AppEnv>();

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
}

function html(body: string, status: number): Response {
  return new Response(body, {
    status,
    headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" },
  });
}

function rendered(step: AuthorizeStep): Response {
  if (step.kind === "redirect") {
    return new Response(null, {
      status: 302,
      headers: { location: step.location, "cache-control": "no-store" },
    });
  }
  if (step.kind === "invalid") {
    return html(errorPage(step.message), 400);
  }
  return html(step.kind === "prompt" ? emailPage(step) : codePage(step), 200);
}

wellKnownRoutes.get("/.well-known/oauth-authorization-server", (c) => {
  return json(authorizationServerMetadata(c.env), 200);
});

wellKnownRoutes.get("/.well-known/oauth-protected-resource", (c) => {
  return json(protectedResourceMetadata(c.env), 200);
});

oauthRoutes.post("/oauth/register", async (c) => {
  const body = await readJson<RegisterClientInput>(c);
  const result = await registerClient(c.env, body, {
    ip: c.req.header("cf-connecting-ip") ?? null,
  });
  return result.kind === "client"
    ? json(result.client, 201)
    : json({ error: result.error, error_description: result.error_description }, result.status);
});

oauthRoutes.get("/oauth/authorize", async (c) => {
  const query = new URL(c.req.url).searchParams;
  return rendered(
    await beginAuthorization(c.env, {
      response_type: query.get("response_type"),
      client_id: query.get("client_id"),
      redirect_uri: query.get("redirect_uri"),
      code_challenge: query.get("code_challenge"),
      code_challenge_method: query.get("code_challenge_method"),
      state: query.get("state"),
      scope: query.get("scope"),
    }),
  );
});

function field(form: FormData, name: string): string | null {
  const value = form.get(name);
  return typeof value === "string" ? value : null;
}

oauthRoutes.post("/oauth/authorize", async (c) => {
  const form = await c.req.raw.formData();
  const sessionId = field(form, "session_id");
  return rendered(
    field(form, "step") === "code"
      ? await submitAuthorizationCode(c.env, { session_id: sessionId, code: field(form, "code") })
      : await submitAuthorizationEmail(c.env, {
          session_id: sessionId,
          email: field(form, "email"),
        }),
  );
});

oauthRoutes.post("/oauth/token", async (c) => {
  const form = await c.req.raw.formData();
  const result = await exchangeToken(c.env, {
    grant_type: field(form, "grant_type"),
    code: field(form, "code"),
    redirect_uri: field(form, "redirect_uri"),
    client_id: field(form, "client_id"),
    code_verifier: field(form, "code_verifier"),
  });
  return result.kind === "token"
    ? json({ access_token: result.access_token, token_type: result.token_type }, 200)
    : json({ error: result.error, error_description: result.error_description }, result.status);
});
