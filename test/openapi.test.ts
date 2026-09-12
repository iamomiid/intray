import { SELF } from "cloudflare:test";
import { expect, it } from "vitest";
import { app } from "../src/http/app";
import { openapiDocument } from "../src/http/openapi";

const PUBLIC_URL = "http://localhost:8787";

interface OpenApiOperation {
  operationId: string;
  summary: string;
  tags: string[];
  parameters: { name: string; in: string; required: boolean; schema: unknown }[];
  requestBody?: { required: boolean; content: Record<string, { schema: unknown }> };
  responses: Record<string, { description: string; content: Record<string, { schema: unknown }> }>;
  security?: unknown[];
}

interface OpenApiDocument {
  openapi: string;
  info: { title: string; version: string; description: string };
  servers: { url: string }[];
  security: unknown[];
  tags: { name: string }[];
  paths: Record<string, Record<string, OpenApiOperation>>;
  components: {
    securitySchemes: Record<string, Record<string, unknown>>;
    schemas: Record<string, Record<string, unknown>>;
  };
}

const HTTP_METHODS = ["get", "post", "patch", "put", "delete"];

function parsed(): OpenApiDocument {
  return JSON.parse(openapiDocument(PUBLIC_URL)) as OpenApiDocument;
}

function servedOperations(): string[] {
  const keys = app.routes
    .filter((route) => HTTP_METHODS.includes(route.method.toLowerCase()))
    .map((route) => `${route.method.toLowerCase()} ${route.path.replace(/:(\w+)/g, "{$1}")}`);
  return [...new Set(keys)].sort();
}

function documentedOperations(): string[] {
  const document = parsed();
  const keys = Object.entries(document.paths).flatMap(([path, operations]) =>
    Object.keys(operations).map((method) => `${method} ${path}`),
  );
  return [...new Set(keys)].sort();
}

function refs(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.flatMap(refs);
  }
  if (typeof value !== "object" || value === null) {
    return [];
  }
  return Object.entries(value as Record<string, unknown>).flatMap(([key, nested]) =>
    key === "$ref" && typeof nested === "string" ? [nested] : refs(nested),
  );
}

it("serves the document unauthenticated as cacheable json", async () => {
  const response = await SELF.fetch("http://intray.test/openapi.json");
  expect(response.status).toBe(200);
  expect(response.headers.get("content-type")).toBe("application/json");
  expect(response.headers.get("cache-control")).toBe("public, max-age=300");

  const document = (await response.json()) as OpenApiDocument;
  expect(document.openapi).toBe("3.1.0");
  expect(document.info.title).toBe("intray");
  expect(document.servers).toEqual([{ url: PUBLIC_URL }]);
});

it("documents every route the app serves and serves every route it documents", () => {
  expect(documentedOperations()).toEqual(servedOperations());
});

it("documents every /v1 route the app serves", () => {
  const served = servedOperations().filter((key) => key.includes(" /v1/"));
  const documented = documentedOperations().filter((key) => key.includes(" /v1/"));
  expect(served.length).toBeGreaterThan(30);
  expect(documented).toEqual(served);
});

it("names the bearer key and the X-API-Key header as security schemes", () => {
  const document = parsed();
  expect(document.components.securitySchemes.bearer_key).toEqual({
    type: "http",
    scheme: "bearer",
    description: "Authorization: Bearer it_...",
  });
  expect(document.components.securitySchemes.api_key_header).toEqual({
    type: "apiKey",
    in: "header",
    name: "X-API-Key",
    description: "X-API-Key: it_...",
  });
  expect(document.security).toEqual([{ bearer_key: [] }, { api_key_header: [] }]);
});

it("leaves signup and the service endpoints unauthenticated", () => {
  const document = parsed();
  expect(document.paths["/v1/agent/signup"]?.post?.security).toEqual([]);
  expect(document.paths["/healthz"]?.get?.security).toEqual([]);
  expect(document.paths["/openapi.json"]?.get?.security).toEqual([]);
  expect(document.paths["/v1/auth/me"]?.get?.security).toBeUndefined();
});

it("gives every authenticated operation a 401 and every operation a 500", () => {
  const document = parsed();
  for (const [path, operations] of Object.entries(document.paths)) {
    for (const [method, operation] of Object.entries(operations)) {
      expect(operation.responses["500"], `${method} ${path}`).toBeDefined();
      const authenticated = operation.security === undefined;
      expect(operation.responses["401"] !== undefined, `${method} ${path}`).toBe(authenticated);
    }
  }
});

it("resolves every $ref against components.schemas", () => {
  const document = parsed();
  const names = new Set(Object.keys(document.components.schemas));
  const pointers = [...new Set(refs(document))];
  expect(pointers.length).toBeGreaterThan(0);
  for (const pointer of pointers) {
    expect(pointer.startsWith("#/components/schemas/"), pointer).toBe(true);
    expect(names.has(pointer.slice("#/components/schemas/".length)), pointer).toBe(true);
  }
});

it("carries no schema-only keywords into components", () => {
  const document = parsed();
  for (const [name, schema] of Object.entries(document.components.schemas)) {
    expect(Object.hasOwn(schema, "$schema"), name).toBe(false);
    expect(Object.hasOwn(schema, "$id"), name).toBe(false);
  }
});

it("describes the path parameters an inbox-scoped operation takes", () => {
  const document = parsed();
  const operation = document.paths["/v1/inboxes/{inbox_id}/messages/{message_id}"]?.get;
  expect(operation?.parameters.map((parameter) => parameter.name)).toEqual([
    "inbox_id",
    "message_id",
  ]);
  for (const parameter of operation?.parameters ?? []) {
    expect(parameter.in).toBe("path");
    expect(parameter.required).toBe(true);
  }
});

it("marks an optional query parameter optional", () => {
  const document = parsed();
  const operation = document.paths["/v1/inboxes/{inbox_id}/messages"]?.get;
  const limit = operation?.parameters.find((parameter) => parameter.name === "limit");
  expect(limit?.in).toBe("query");
  expect(limit?.required).toBe(false);
  expect(limit?.schema).toEqual({ type: "number" });
});

it("points a json request body and response at the shared schemas", () => {
  const document = parsed();
  const send = document.paths["/v1/inboxes/{inbox_id}/messages/send"]?.post;
  expect(send?.requestBody?.required).toBe(true);
  expect(send?.requestBody?.content["application/json"]?.schema).toEqual({
    $ref: "#/components/schemas/send_message_body",
  });
  expect(send?.responses["201"]?.content["application/json"]?.schema).toEqual({
    $ref: "#/components/schemas/message",
  });
});

it("declares the non-json responses with their media types", () => {
  const document = parsed();
  const raw = document.paths["/v1/inboxes/{inbox_id}/messages/{message_id}/raw"]?.get;
  expect(raw?.responses["200"]?.content["message/rfc822"]?.schema).toEqual({
    type: "string",
    format: "binary",
  });
  const text =
    document.paths["/v1/inboxes/{inbox_id}/messages/{message_id}/attachments/{attachment_id}/text"]
      ?.get;
  expect(text?.responses["200"]?.content["text/plain"]?.schema).toEqual({ type: "string" });
});

it("builds the document once per public url", () => {
  expect(openapiDocument(PUBLIC_URL)).toBe(openapiDocument(PUBLIC_URL));
  expect(openapiDocument("https://intray.example.workers.dev")).not.toBe(
    openapiDocument(PUBLIC_URL),
  );
});
