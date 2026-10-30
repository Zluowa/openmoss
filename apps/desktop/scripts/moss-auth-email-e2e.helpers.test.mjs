import assert from "node:assert/strict";
import { test } from "vitest";

import {
  buildAppHashRoute,
  classifyAuthMail,
  decodeMailMarkup,
  extractAuthActionLink,
  extractMossAuthCode,
  maskEmail,
  messageContent,
  messageIdentity,
} from "./moss-auth-email-e2e.helpers.mjs";

test("masks both sides of an email address", () => {
  assert.equal(maskEmail("person@example.test"), "p***@e***.test");
  assert.equal(maskEmail("invalid"), "***");
});

test("decodes mail markup and extracts the auth action without exposing it to logs", () => {
  const markup =
    '<a href="http://127.0.0.1:54321/auth/v1/verify?token=fixture&amp;type=signup">Confirm</a>';
  assert.equal(decodeMailMarkup(markup).includes("&type=signup"), true);
  assert.equal(
    extractAuthActionLink(markup),
    "http://127.0.0.1:54321/auth/v1/verify?token=fixture&type=signup",
  );
  assert.equal(classifyAuthMail({ subject: "Confirm your signup", content: markup }), "signup");
});

test("recognizes recovery mail from its action URL", () => {
  const content = "http://localhost:54321/auth/v1/verify?token=fixture&type=recovery";
  assert.equal(classifyAuthMail({ content }), "recovery");
});

test("extracts an auth action from quoted-printable HTML", () => {
  const content =
    'href=3D"http://localhost:54321/auth/v1/verify?token=3Dfixture&amp;type=3Drecovery"';
  assert.equal(
    extractAuthActionLink(content),
    "http://localhost:54321/auth/v1/verify?token=fixture&type=recovery",
  );
});

test("accepts only the expected Moss callback and returns its code", () => {
  assert.equal(extractMossAuthCode("moss://auth/callback?code=fixture-code"), "fixture-code");
  assert.equal(extractMossAuthCode("moss://other/callback?code=fixture-code"), null);
});

test("builds a hash route for dev and packaged app URLs", () => {
  assert.equal(
    buildAppHashRoute("http://localhost:5733/#/login", "/auth/callback", {
      code: "value with spaces",
    }),
    "http://localhost:5733/#/auth/callback?code=value+with+spaces",
  );
  assert.equal(
    buildAppHashRoute("moss://app/index.html", "/forgot-password"),
    "moss://app/index.html#/forgot-password",
  );
});

test("reads common Mailpit and Inbucket message shapes", () => {
  assert.equal(messageIdentity({ ID: "mailpit-id" }), "mailpit-id");
  assert.equal(messageIdentity({ id: "inbucket-id" }), "inbucket-id");
  assert.equal(
    messageContent({ Subject: "Subject", Text: "Plain", HTML: "<p>HTML</p>" }),
    "Subject\nPlain\n<p>HTML</p>",
  );
});
