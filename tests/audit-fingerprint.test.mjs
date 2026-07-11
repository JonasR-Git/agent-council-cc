import assert from "node:assert/strict";
import test from "node:test";

import { FINGERPRINT_VERSION, isVersioned, semanticFingerprint } from "../plugins/council/scripts/lib/audit-fingerprint.mjs";

const base = { file: "src/a.mjs", lens: "correctness", ruleId: "empty-catch", anchor: "handleRequest" };

test("fingerprint is versioned + slash-normalized but CASE-preserving", () => {
  const fp = semanticFingerprint(base);
  assert.ok(isVersioned(fp));
  assert.match(fp, new RegExp(`^fp${FINGERPRINT_VERSION}\\|src/a.mjs\\|correctness\\|empty-catch\\|`));
  assert.equal(semanticFingerprint({ ...base, file: "src\\a.mjs" }), fp, "backslashes normalize to one identity");
  assert.notEqual(semanticFingerprint({ ...base, file: "src/A.mjs" }), fp, "case is significant (case-sensitive FS)");
});

test("file comes from location.path (canonical shape) and distinguishes files", () => {
  const viaLoc = semanticFingerprint({ lens: "correctness", ruleId: "empty-catch", anchor: "handleRequest", location: { path: "src/a.mjs", startLine: 5 } });
  assert.equal(viaLoc, semanticFingerprint(base), "location.path === f.file identity");
  assert.notEqual(
    semanticFingerprint({ ...base, file: "src/b.mjs" }),
    semanticFingerprint({ ...base, file: "src/a.mjs" }),
    "different files never collide even with same lens/rule/anchor"
  );
});

test("ordinal disambiguates two findings sharing file+lens+rule+anchor", () => {
  const first = semanticFingerprint({ ...base, ordinal: 0 });
  const second = semanticFingerprint({ ...base, ordinal: 1 });
  assert.notEqual(first, second, "two empty catches in one function get distinct identities");
  assert.equal(semanticFingerprint(base), semanticFingerprint(base), "no ordinal -> stable");
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
