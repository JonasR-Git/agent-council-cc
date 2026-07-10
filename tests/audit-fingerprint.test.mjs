import assert from "node:assert/strict";
import test from "node:test";

import { FINGERPRINT_VERSION, isVersioned, semanticFingerprint } from "../plugins/council/scripts/lib/audit-fingerprint.mjs";

const base = { file: "src/a.mjs", lens: "correctness", ruleId: "empty-catch", anchor: "handleRequest" };

test("fingerprint is versioned and posix/case-normalized", () => {
  const fp = semanticFingerprint(base);
  assert.ok(isVersioned(fp));
  assert.match(fp, new RegExp(`^fp${FINGERPRINT_VERSION}\\|src/a.mjs\\|correctness\\|empty-catch\\|`));
  assert.equal(semanticFingerprint({ ...base, file: "src\\A.mjs" }), fp, "backslashes + case normalized to one identity");
});

test("stable across line moves, distinct across rule/anchor", () => {
  const at12 = semanticFingerprint({ ...base, line: 12 });
  const at480 = semanticFingerprint({ ...base, line: 480 });
  assert.equal(at12, at480, "line number does not drift the identity");

  assert.notEqual(semanticFingerprint(base), semanticFingerprint({ ...base, ruleId: "swallowed-error" }), "different rule -> different id");
  assert.notEqual(semanticFingerprint(base), semanticFingerprint({ ...base, anchor: "otherFn" }), "different anchor -> different id");
  assert.notEqual(semanticFingerprint(base), semanticFingerprint({ ...base, lens: "security_secrets" }), "different lens -> different id");
});

test("an anchor beats title drift; without an anchor the title is the fallback", () => {
  const a = semanticFingerprint({ ...base, title: "Empty catch swallows the error" });
  const b = semanticFingerprint({ ...base, title: "This catch block silently ignores failures" });
  assert.equal(a, b, "reworded title does not drift the id when an anchor exists");

  const noAnchor = { file: "src/a.mjs", lens: "correctness", ruleId: "x" };
  assert.notEqual(
    semanticFingerprint({ ...noAnchor, title: "one" }),
    semanticFingerprint({ ...noAnchor, title: "two" }),
    "without an anchor, the title hash is the last-resort discriminator"
  );
});

test("isVersioned distinguishes new from legacy fingerprints", () => {
  assert.equal(isVersioned("fp1|src/a.mjs|correctness|r|a:x"), true);
  assert.equal(isVersioned("src/a.mjs::0::empty-catch"), false, "legacy ledger key is not versioned");
});
