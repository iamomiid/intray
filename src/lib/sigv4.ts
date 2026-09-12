import { sha256Hex, toHex } from "./hash";

export interface SigV4Credentials {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken: string | null;
  region: string;
  service: string;
}

export interface SigV4Request {
  method: string;
  url: string;
  headers: Record<string, string>;
  body: string;
  at: Date;
}

const ALGORITHM = "AWS4-HMAC-SHA256";

const encoder = new TextEncoder();

function pad(value: number): string {
  return value.toString().padStart(2, "0");
}

export function amzDate(at: Date): string {
  const date = `${at.getUTCFullYear()}${pad(at.getUTCMonth() + 1)}${pad(at.getUTCDate())}`;
  const time = `${pad(at.getUTCHours())}${pad(at.getUTCMinutes())}${pad(at.getUTCSeconds())}`;
  return `${date}T${time}Z`;
}

function encodeRfc3986(value: string): string {
  return encodeURIComponent(value).replace(
    /[!'()*]/g,
    (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

function compare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

async function hmac(key: Uint8Array, data: string): Promise<Uint8Array> {
  const imported = await crypto.subtle.importKey(
    "raw",
    key,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign("HMAC", imported, encoder.encode(data));
  return new Uint8Array(signature);
}

export async function signingKey(
  secretAccessKey: string,
  dateStamp: string,
  region: string,
  service: string,
): Promise<Uint8Array> {
  const dateKey = await hmac(encoder.encode(`AWS4${secretAccessKey}`), dateStamp);
  const regionKey = await hmac(dateKey, region);
  const serviceKey = await hmac(regionKey, service);
  return hmac(serviceKey, "aws4_request");
}

function canonicalPath(url: URL): string {
  return url.pathname
    .split("/")
    .map((segment) => encodeRfc3986(decodeURIComponent(segment)))
    .join("/");
}

function canonicalQuery(url: URL): string {
  return [...url.searchParams.entries()]
    .map(([name, value]): [string, string] => [encodeRfc3986(name), encodeRfc3986(value)])
    .sort((left, right) =>
      left[0] === right[0] ? compare(left[1], right[1]) : compare(left[0], right[0]),
    )
    .map(([name, value]) => `${name}=${value}`)
    .join("&");
}

function normalizedHeaders(headers: Record<string, string>): [string, string][] {
  return Object.entries(headers)
    .map(([name, value]): [string, string] => [
      name.toLowerCase(),
      value.trim().replace(/\s+/g, " "),
    ])
    .sort((left, right) => compare(left[0], right[0]));
}

export interface SignedRequest {
  headers: Record<string, string>;
  canonicalRequest: string;
  stringToSign: string;
  signature: string;
  authorization: string;
}

export async function signRequest(
  credentials: SigV4Credentials,
  request: SigV4Request,
): Promise<SignedRequest> {
  const url = new URL(request.url);
  const stamp = amzDate(request.at);
  const dateStamp = stamp.slice(0, 8);
  const payloadHash = await sha256Hex(request.body);
  const withRequired = {
    ...request.headers,
    host: url.host,
    "x-amz-date": stamp,
    ...(credentials.sessionToken === null || credentials.sessionToken === ""
      ? {}
      : { "x-amz-security-token": credentials.sessionToken }),
  };
  const pairs = normalizedHeaders(withRequired);
  const signedHeaders = pairs.map(([name]) => name).join(";");
  const canonicalRequest = [
    request.method.toUpperCase(),
    canonicalPath(url),
    canonicalQuery(url),
    `${pairs.map(([name, value]) => `${name}:${value}`).join("\n")}\n`,
    signedHeaders,
    payloadHash,
  ].join("\n");
  const scope = `${dateStamp}/${credentials.region}/${credentials.service}/aws4_request`;
  const stringToSign = [ALGORITHM, stamp, scope, await sha256Hex(canonicalRequest)].join("\n");
  const key = await signingKey(
    credentials.secretAccessKey,
    dateStamp,
    credentials.region,
    credentials.service,
  );
  const signature = toHex(await hmac(key, stringToSign));
  const authorization = `${ALGORITHM} Credential=${credentials.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;
  return {
    headers: { ...withRequired, authorization },
    canonicalRequest,
    stringToSign,
    signature,
    authorization,
  };
}
