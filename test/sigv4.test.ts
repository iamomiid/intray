import { expect, it } from "vitest";
import { toHex } from "../src/lib/hash";
import { amzDate, signingKey, signRequest } from "../src/lib/sigv4";

const DOCUMENTED_ID = "AKIDEXAMPLE";

const DOCUMENTED_VALUE = "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY";

const AT = new Date(Date.UTC(2015, 7, 30, 12, 36, 0));

it("derives the signing key of the documented example", async () => {
  const derived = await signingKey(DOCUMENTED_VALUE, "20150830", "us-east-1", "iam");
  expect(toHex(derived)).toBe("c4afb1cc5771d871763a393e44b703571b55cc28424d1a5e86da6ed3c154a4b9");
});

it("formats the amz date", () => {
  expect(amzDate(AT)).toBe("20150830T123600Z");
});

it("signs the documented get-vanilla request", async () => {
  const signed = await signRequest(
    {
      accessKeyId: DOCUMENTED_ID,
      secretAccessKey: DOCUMENTED_VALUE,
      sessionToken: null,
      region: "us-east-1",
      service: "service",
    },
    {
      method: "GET",
      url: "https://example.amazonaws.com/",
      headers: {},
      body: "",
      at: AT,
    },
  );

  expect(signed.canonicalRequest).toBe(
    [
      "GET",
      "/",
      "",
      "host:example.amazonaws.com",
      "x-amz-date:20150830T123600Z",
      "",
      "host;x-amz-date",
      "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    ].join("\n"),
  );
  expect(signed.stringToSign.split("\n").slice(0, 3)).toEqual([
    "AWS4-HMAC-SHA256",
    "20150830T123600Z",
    "20150830/us-east-1/service/aws4_request",
  ]);
  expect(signed.signature).toBe("5fa00fa31553b73ebf1942676e86291e8372ff2a2260956d9b8aae1d763fbf31");
});
