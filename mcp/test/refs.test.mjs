import { test } from "node:test";
import assert from "node:assert/strict";
import { makeRef, parseRef } from "../dist/bridge.js";

test("references name the JVM only when several bridges run", () => {
  assert.equal(makeRef(123, "/app/con[0]/ses[1]", 1), "con[0]/ses[1]");
  assert.equal(makeRef(123, "/app/con[0]/ses[1]", 2), "123/con[0]/ses[1]");
});
test("parseRef", () => {
  assert.deepEqual(parseRef("123/con[0]/ses[1]"), { pid: 123, session: "con[0]/ses[1]" });
  assert.deepEqual(parseRef("con[1]/ses[0]"), { session: "con[1]/ses[0]" });
  assert.deepEqual(parseRef("/app/con[0]/ses[2]"), { session: "con[0]/ses[2]" });
});
