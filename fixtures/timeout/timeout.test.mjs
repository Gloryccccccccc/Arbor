import { test } from "node:test";
import assert from "node:assert/strict";
import { timeout } from "./timeout.mjs";

test("zero is a valid timeout", () => {
  assert.equal(timeout({ timeout: 0 }), 0);
});

test("missing timeout uses the default", () => {
  assert.equal(timeout({}), 1000);
});
