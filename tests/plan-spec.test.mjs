import assert from "node:assert/strict";
import test from "node:test";

import {
  PLAN_LIMITS,
  PLAN_SCHEMA_VERSION,
  classifyStep,
  isPlanProtectedPath,
  isPlanTestPath,
  normalizePlanSpec,
  normalizeRequest,
  parsePlanSpec,
  planSpecDigest,
  planStepImplFiles,
  planStepTestFiles,
  planStepTouched,
  renderPlanMarkdown,
  requestDigest,
  validatePlanSpec
} from "../plugins/council/scripts/lib/plan-spec.mjs";

const REQUEST = "Add a widget parser to the library";
const BASE = "a".repeat(40);

/** A fresh, fully valid two-step spec (step 2 edits the file step 1 creates). */
function makeSpec() {
  return {
    schemaVersion: PLAN_SCHEMA_VERSION,
    request: REQUEST,
    requestHash: requestDigest(REQUEST),
    baseCommit: BASE,
    steps: [
      {
        id: "widget-parser",
        title: "Widget parser",
        intent: "Introduce parseWidget that turns a widget string into fields",
        files: [
          { path: "lib/widget.mjs", action: "create", role: "source", intent: "the parser" },
          { path: "tests/widget.test.mjs", action: "create", role: "test", intent: "proves parsing" }
        ],
        test: { files: ["tests/widget.test.mjs"], intent: "parseWidget returns the declared fields" },
        dependsOn: []
      },
      {
        id: "widget-render",
        title: "Widget renderer",
        intent: "Render a parsed widget back to text",
        files: [
          { path: "lib/widget.mjs", action: "edit", role: "source", intent: "add renderWidget" },
          { path: "tests/widget-render.test.mjs", action: "create", role: "test", intent: "proves rendering" }
        ],
        test: { files: ["tests/widget-render.test.mjs"], intent: "renderWidget round-trips a parsed widget" },
        dependsOn: ["widget-parser"]
      }
    ],
    risks: [{ id: "r1", description: "grammar ambiguity", mitigation: "strict grammar with rejects" }],
    testStrategy: { perStep: "full", final: "full" }
  };
}

// A fake tree: only these repo-relative posix paths exist as regular files.
const TREE = new Set(["lib/existing.mjs", "README.md"]);
const fileExists = (p) => (TREE.has(p) ? "file" : false);
const OPTS = { root: ".", fileExists };

/** Rebuild an object graph with every object's keys in REVERSED insertion order. */
function reorderKeys(v) {
  if (Array.isArray(v)) return v.map(reorderKeys);
  if (v && typeof v === "object") {
    const out = {};
    for (const k of Object.keys(v).reverse()) out[k] = reorderKeys(v[k]);
    return out;
  }
  return v;
}

function expectInvalid(spec, re, opts = OPTS) {
  const r = validatePlanSpec(spec, opts);
  assert.equal(r.valid, false);
  assert.equal(r.value, null);
  assert.ok(r.errors.some((e) => re.test(e)), `expected an error matching ${re}, got:\n  ${r.errors.join("\n  ")}`);
  return r;
}

// ---------------------------------------------------------------------------
// happy path + round trip
// ---------------------------------------------------------------------------

test("a valid spec round-trips: JSON text → parse → validate → normalized value", () => {
  const spec = makeSpec();
  const parsed = parsePlanSpec(JSON.stringify(spec));
  assert.equal(parsed.ok, true);
  assert.equal(parsed.error, null);
  const r = validatePlanSpec(parsed.spec, OPTS);
  assert.deepEqual(r.errors, []);
  assert.equal(r.valid, true);
  assert.ok(r.value);
  // the normalized value is itself valid (idempotent contract)
  const again = validatePlanSpec(r.value, OPTS);
  assert.equal(again.valid, true);
  assert.deepEqual(again.value, r.value);
});

test("parsePlanSpec accepts a plain object as-is and rejects everything else", () => {
  const spec = makeSpec();
  assert.equal(parsePlanSpec(spec).ok, true);
  assert.equal(parsePlanSpec(42).ok, false);
  assert.equal(parsePlanSpec(null).ok, false);
  assert.equal(parsePlanSpec([1, 2]).ok, false);
  assert.equal(parsePlanSpec("not json {").ok, false);
  assert.equal(parsePlanSpec("[1,2]").ok, false); // root must be an object
  assert.equal(parsePlanSpec('"just a string"').ok, false);
});

test("parsePlanSpec rejects oversized input instead of truncating", () => {
  const r = parsePlanSpec("x".repeat(PLAN_LIMITS.specChars + 1));
  assert.equal(r.ok, false);
  assert.match(r.error, /exceeds/);
});

test("parsePlanSpec strips a UTF-8 BOM before the strict parse", () => {
  const r = parsePlanSpec("\uFEFF" + JSON.stringify(makeSpec()));
  assert.equal(r.ok, true);
});

// ---------------------------------------------------------------------------
// fail-closed rules
// ---------------------------------------------------------------------------

test("unknown keys reject at every level (top / step / file / test / risk / strategy)", () => {
  const top = makeSpec();
  top.extra = 1;
  expectInvalid(top, /spec: unknown key 'extra'/);

  const step = makeSpec();
  step.steps[0].shell = "rm -rf";
  expectInvalid(step, /steps\[0\]: unknown key 'shell'/);

  const file = makeSpec();
  file.steps[0].files[0].mode = "0777";
  expectInvalid(file, /files\[0\]: unknown key 'mode'/);

  const t = makeSpec();
  t.steps[0].test.cmd = "curl evil";
  expectInvalid(t, /test: unknown key 'cmd'/);

  const risk = makeSpec();
  risk.risks[0].note = "x";
  expectInvalid(risk, /risks\[0\]: unknown key 'note'/);

  const ts = makeSpec();
  ts.testStrategy.skip = true;
  expectInvalid(ts, /testStrategy: unknown key 'skip'/);
});

test("missing required keys reject (fail-closed, not defaulted)", () => {
  for (const key of ["schemaVersion", "request", "requestHash", "baseCommit", "steps", "risks", "testStrategy"]) {
    const spec = makeSpec();
    delete spec[key];
    expectInvalid(spec, new RegExp(`missing key '${key}'|${key} must`));
  }
  const noTest = makeSpec();
  delete noTest.steps[0].test;
  expectInvalid(noTest, /steps\[0\]: missing key 'test'/);
});

test("schemaVersion, requestHash and baseCommit are strict", () => {
  const v = makeSpec();
  v.schemaVersion = 2;
  expectInvalid(v, /schemaVersion must be exactly 1/);

  const h = makeSpec();
  h.requestHash = "deadbeef";
  expectInvalid(h, /requestHash must be 64 lowercase hex/);

  const mismatch = makeSpec();
  mismatch.requestHash = "0".repeat(64);
  expectInvalid(mismatch, /requestHash does not match/);

  const sha = makeSpec();
  sha.baseCommit = "HEAD";
  expectInvalid(sha, /baseCommit must be a full 40-char lowercase hex git sha/);
});

test("requestDigest binds through whitespace normalization only", () => {
  assert.equal(requestDigest("  Add   a widget\tparser to the\nlibrary "), requestDigest(REQUEST));
  assert.notEqual(requestDigest("a different request"), requestDigest(REQUEST));
  assert.equal(normalizeRequest("  a \n b\t c  "), "a b c");
});

test("duplicate step ids and malformed ids reject", () => {
  const dup = makeSpec();
  dup.steps[1].id = "widget-parser";
  expectInvalid(dup, /duplicate id 'widget-parser'/);

  for (const bad of ["Widget", "1step", "-x", "a".repeat(65), "", 42]) {
    const spec = makeSpec();
    spec.steps[0].id = bad;
    expectInvalid(spec, /id must match/);
  }
});

test("dependsOn: forward, self, unknown and cyclic references all reject (earlier-only)", () => {
  const fwd = makeSpec();
  fwd.steps[0].dependsOn = ["widget-render"];
  expectInvalid(fwd, /steps\[0\]\.dependsOn: 'widget-render' is not an EARLIER step/);

  const self = makeSpec();
  self.steps[1].dependsOn = ["widget-render"];
  expectInvalid(self, /steps\[1\]\.dependsOn: 'widget-render' is not an EARLIER step/);

  const unknown = makeSpec();
  unknown.steps[1].dependsOn = ["nope"];
  expectInvalid(unknown, /'nope' is not an EARLIER step/);

  // a 2-cycle necessarily contains a forward reference — rejected by construction
  const cycle = makeSpec();
  cycle.steps[0].dependsOn = ["widget-render"];
  cycle.steps[1].dependsOn = ["widget-parser"];
  expectInvalid(cycle, /is not an EARLIER step/);

  const dupDep = makeSpec();
  dupDep.steps[1].dependsOn = ["widget-parser", "widget-parser"];
  expectInvalid(dupDep, /dependsOn: duplicate/);
});

test("dependsOn is optional and defaults to [] in the normalized value", () => {
  const spec = makeSpec();
  delete spec.steps[0].dependsOn;
  const r = validatePlanSpec(spec, OPTS);
  assert.equal(r.valid, true);
  assert.deepEqual(r.value.steps[0].dependsOn, []);
});

test("path safety: traversal, absolute, drive (both forms), backslash, control chars, whitespace", () => {
  const cases = [
    ["../escape.mjs", /unsafe \(traversal\/absolute\/drive\)/],
    ["lib/../../x.mjs", /unsafe \(traversal\/absolute\/drive\)/],
    ["/etc/passwd", /unsafe \(traversal\/absolute\/drive\)/],
    ["C:/evil.mjs", /unsafe \(traversal\/absolute\/drive\)/],
    ["C:evil.mjs", /unsafe \(traversal\/absolute\/drive\)/], // drive-RELATIVE form
    ["lib\\widget.mjs", /backslash/],
    ["lib/a\u0000.mjs", /control chars or edge whitespace/],
    [" lib/a.mjs", /control chars or edge whitespace/],
    ["lib//a.mjs", /empty or '\.' segment/],
    ["./lib/a.mjs", /empty or '\.' segment/],
    ["", /must be a non-empty string/]
  ];
  for (const [path, re] of cases) {
    const spec = makeSpec();
    spec.steps[0].files[0].path = path;
    expectInvalid(spec, re);
  }
});

test("protected paths reject for EVERY role (CI/git/deps/lockfiles/secrets/.council)", () => {
  const protectedPaths = [
    ".github/workflows/ci.yml",
    ".git/hooks/pre-commit",
    "node_modules/x/index.mjs",
    "package-lock.json",
    ".env",
    ".env.local",
    ".council/state.json",
    ".gitlab-ci.yml",
    "deploy/id_rsa",
    "certs/server.pem",
    ".npmrc"
  ];
  for (const p of protectedPaths) {
    assert.equal(isPlanProtectedPath(p), true, `expected protected: ${p}`);
    const spec = makeSpec();
    spec.steps[0].files[0].path = p; // role stays "source"
    expectInvalid(spec, /protected path/);
  }
  // the relaxation NEVER unprotects these: even declared role:"test" they stay banned
  const spec = makeSpec();
  spec.steps[0].files[1] = { path: ".github/x.test.mjs", action: "create", role: "test", intent: "x" };
  spec.steps[0].test.files = [".github/x.test.mjs"];
  expectInvalid(spec, /protected path/);
});

test("an UNDECLARED test path rejects; the same path declared role:'test' is allowed", () => {
  // test-convention path smuggled in as role "source" → the test-file ban applies
  const sneaky = makeSpec();
  sneaky.steps[0].files.push({ path: "tests/sneaky.test.mjs", action: "create", role: "source", intent: "x" });
  expectInvalid(sneaky, /test path 'tests\/sneaky\.test\.mjs' not declared role:'test'/);

  // the identical path declared role:"test" AND listed in test.files → valid
  const declared = makeSpec();
  declared.steps[0].files.push({ path: "tests/sneaky.test.mjs", action: "create", role: "test", intent: "x" });
  declared.steps[0].test.files.push("tests/sneaky.test.mjs");
  assert.equal(validatePlanSpec(declared, OPTS).valid, true);
});

test("role:'test' must match a test convention, and test.files must EQUAL the role:'test' set", () => {
  const nonConvention = makeSpec();
  nonConvention.steps[0].files.push({ path: "lib/helper.mjs", action: "create", role: "test", intent: "x" });
  nonConvention.steps[0].test.files.push("lib/helper.mjs");
  expectInvalid(nonConvention, /does not match a recognized test convention/);

  // role:test file NOT listed in test.files → rejected
  const unlisted = makeSpec();
  unlisted.steps[0].files.push({ path: "tests/extra.test.mjs", action: "create", role: "test", intent: "x" });
  expectInvalid(unlisted, /role:'test' file 'tests\/extra\.test\.mjs' missing from test\.files/);

  // test.files entry not declared in files[] → rejected
  const undeclared = makeSpec();
  undeclared.steps[0].test.files = ["tests/ghost.test.mjs"];
  expectInvalid(undeclared, /'tests\/ghost\.test\.mjs' is not declared in files\[\] with role:'test'/);
});

test("create-on-existing and edit-on-missing reject against the injected tree", () => {
  const createExisting = makeSpec();
  createExisting.steps[0].files[0].path = "lib/existing.mjs";
  expectInvalid(createExisting, /create but 'lib\/existing\.mjs' already exists/);

  const editMissing = makeSpec();
  editMissing.steps[0].files[0] = { path: "lib/missing.mjs", action: "edit", role: "source", intent: "x" };
  expectInvalid(editMissing, /edit but 'lib\/missing\.mjs' does not exist/);
});

test("the virtual overlay advances step by step: edit-after-create passes, create-twice rejects", () => {
  // the base spec already edits lib/widget.mjs in step 2 after creating it in step 1
  assert.equal(validatePlanSpec(makeSpec(), OPTS).valid, true);

  const createTwice = makeSpec();
  createTwice.steps[1].files[0] = { path: "lib/widget.mjs", action: "create", role: "source", intent: "x" };
  expectInvalid(createTwice, /steps\[1\].*create but 'lib\/widget\.mjs' already exists/);
});

test("fileExists is mandatory and fail-closed on throw / dir / unknown kind", () => {
  expectInvalid(makeSpec(), /fileExists is required/, {});

  const throwing = { fileExists: () => { throw new Error("io boom"); } };
  expectInvalid(makeSpec(), /fileExists threw \(io boom\)/, throwing);

  // a directory at the path blocks create AND edit
  const dirProbe = { fileExists: () => "dir" };
  expectInvalid(makeSpec(), /already exists \(dir\)/, dirProbe);
  const editDir = makeSpec();
  editDir.steps[0].files[0] = { path: "lib/existing.mjs", action: "edit", role: "source", intent: "x" };
  expectInvalid(editDir, /is not a regular file \(dir\)/, { fileExists: () => "dir" });

  // boolean true = exists-of-unknown-kind → blocks create AND edit (fail-closed)
  expectInvalid(makeSpec(), /already exists/, { fileExists: () => true });
  const editUnknown = makeSpec();
  editUnknown.steps[0].files = [
    { path: "lib/x.mjs", action: "edit", role: "source", intent: "x" },
    { path: "tests/x.test.mjs", action: "edit", role: "test", intent: "x" }
  ];
  editUnknown.steps[0].test.files = ["tests/x.test.mjs"];
  editUnknown.steps = [editUnknown.steps[0]];
  expectInvalid(editUnknown, /is not a regular file/, { fileExists: () => true });
});

test("steps/files shape: empty steps, empty files, unknown action/role, duplicates reject", () => {
  const noSteps = makeSpec();
  noSteps.steps = [];
  expectInvalid(noSteps, /at least one step/);

  const notArray = makeSpec();
  notArray.steps = "later";
  expectInvalid(notArray, /steps must be an array/);

  const emptyFiles = makeSpec();
  emptyFiles.steps[0].files = [];
  expectInvalid(emptyFiles, /files must be a non-empty array/);

  const badAction = makeSpec();
  badAction.steps[0].files[0].action = "delete";
  expectInvalid(badAction, /unknown action 'delete' \(create\|edit only\)/);

  const badRole = makeSpec();
  badRole.steps[0].files[0].role = "doc";
  expectInvalid(badRole, /unknown role 'doc' \(source\|test only\)/);

  const dupPath = makeSpec();
  dupPath.steps[0].files.push({ path: "lib/widget.mjs", action: "edit", role: "source", intent: "x" });
  expectInvalid(dupPath, /duplicate path 'lib\/widget\.mjs' within the step/);
});

test("a step needs >=1 source file and >=1 test file", () => {
  const testOnly = makeSpec();
  testOnly.steps[0].files = [{ path: "tests/widget.test.mjs", action: "create", role: "test", intent: "x" }];
  expectInvalid(testOnly, /needs at least one role:'source' file/);

  const sourceOnly = makeSpec();
  sourceOnly.steps[0].files = [{ path: "lib/widget.mjs", action: "create", role: "source", intent: "x" }];
  sourceOnly.steps[0].test.files = [];
  expectInvalid(sourceOnly, /needs at least one role:'test' file/);
});

test("testStrategy accepts ONLY the frozen 'full'/'full' mode", () => {
  const perStep = makeSpec();
  perStep.testStrategy.perStep = "quick";
  expectInvalid(perStep, /testStrategy\.perStep must be 'full'/);

  const final = makeSpec();
  final.testStrategy.final = "none";
  expectInvalid(final, /testStrategy\.final must be 'full'/);
});

test("bounded sizes reject: too many steps, oversized text", () => {
  const many = makeSpec();
  const proto = many.steps[0];
  many.steps = Array.from({ length: PLAN_LIMITS.steps + 1 }, (_, i) => ({
    ...structuredClone(proto),
    id: `step-${i}`,
    files: [
      { path: `lib/f${i}.mjs`, action: "create", role: "source", intent: "x" },
      { path: `tests/f${i}.test.mjs`, action: "create", role: "test", intent: "x" }
    ],
    test: { files: [`tests/f${i}.test.mjs`], intent: "x" },
    dependsOn: []
  }));
  expectInvalid(many, /steps exceeds/);

  const longTitle = makeSpec();
  longTitle.steps[0].title = "t".repeat(PLAN_LIMITS.title + 1);
  expectInvalid(longTitle, /title exceeds/);
});

// ---------------------------------------------------------------------------
// planStepTouched / subsets
// ---------------------------------------------------------------------------

test("planStepTouched is the EXACT sorted files[].path set (tests included, nothing widened)", () => {
  const spec = makeSpec();
  assert.deepEqual(planStepTouched(spec.steps[0]), ["lib/widget.mjs", "tests/widget.test.mjs"]);
  assert.deepEqual(planStepTouched(spec.steps[1]), ["lib/widget.mjs", "tests/widget-render.test.mjs"]);
  // dedupe + defensive on shape
  assert.deepEqual(planStepTouched({ files: [{ path: "a" }, { path: "a" }, { path: "b" }] }), ["a", "b"]);
  assert.deepEqual(planStepTouched({}), []);
  assert.deepEqual(planStepTouched(null), []);
  // NOT widened by test.files: an undeclared test path stays OUTSIDE the boundary
  const malformed = { files: [{ path: "lib/a.mjs" }], test: { files: ["tests/ghost.test.mjs"] } };
  assert.deepEqual(planStepTouched(malformed), ["lib/a.mjs"]);
});

test("planStepTestFiles / planStepImplFiles split the boundary by role", () => {
  const step = makeSpec().steps[0];
  assert.deepEqual(planStepTestFiles(step), ["tests/widget.test.mjs"]);
  assert.deepEqual(planStepImplFiles(step), ["lib/widget.mjs"]);
});

// ---------------------------------------------------------------------------
// digest + normalize
// ---------------------------------------------------------------------------

test("planSpecDigest is stable under key reordering and sensitive to any value change", () => {
  const spec = makeSpec();
  const digest = planSpecDigest(spec);
  assert.match(digest, /^[0-9a-f]{64}$/);
  assert.equal(planSpecDigest(reorderKeys(spec)), digest);
  // JSON round-trip is also stable
  assert.equal(planSpecDigest(JSON.parse(JSON.stringify(spec))), digest);

  const changed = makeSpec();
  changed.steps[0].title = "Different title";
  assert.notEqual(planSpecDigest(changed), digest);

  // an INJECTED unknown key must change the digest (tamper-evident, never dropped)
  const tampered = makeSpec();
  tampered.extra = true;
  assert.notEqual(planSpecDigest(tampered), digest);
});

test("normalizePlanSpec sorts the set-like arrays and keeps step order", () => {
  const spec = makeSpec();
  // shuffle files within step 0 (set-like) — normalization must sort them by path
  spec.steps[0].files.reverse();
  const value = validatePlanSpec(spec, OPTS).value;
  assert.deepEqual(value.steps[0].files.map((f) => f.path), ["lib/widget.mjs", "tests/widget.test.mjs"]);
  assert.deepEqual(value.steps.map((s) => s.id), ["widget-parser", "widget-render"]); // order preserved
  // normalized digest is file-order independent
  assert.equal(planSpecDigest(validatePlanSpec(makeSpec(), OPTS).value), planSpecDigest(value));
  // validate's value IS normalizePlanSpec of the input (one canonical form, no second dialect)
  assert.deepEqual(value, normalizePlanSpec(spec));
});

// ---------------------------------------------------------------------------
// classifyStep
// ---------------------------------------------------------------------------

test("classifyStep flags §6-sensitive steps by path and by intent", () => {
  const byPath = classifyStep({
    title: "Token store",
    intent: "Persist things",
    files: [{ path: "lib/auth-token.mjs", action: "create", role: "source", intent: "x" }]
  });
  assert.equal(byPath.sensitive, true);
  assert.ok(byPath.classes.includes("auth"));
  assert.ok(byPath.classes.includes("security"));

  const byIntent = classifyStep({
    title: "Hardening",
    intent: "Encrypt the payload before writing",
    files: [{ path: "lib/io.mjs", action: "edit", role: "source", intent: "x" }]
  });
  assert.equal(byIntent.sensitive, true);
  assert.ok(byIntent.classes.includes("crypto"));
});

test("classifyStep: a benign step is not sensitive; an unclassifiable step IS (fail-closed)", () => {
  const benign = classifyStep(makeSpec().steps[0]);
  assert.equal(benign.sensitive, false);
  assert.deepEqual(benign.classes, []);

  for (const bad of [null, "x", 42, {}, { title: "  " }]) {
    const r = classifyStep(bad);
    assert.equal(r.sensitive, true, `expected fail-closed sensitive for ${JSON.stringify(bad)}`);
    assert.deepEqual(r.classes, ["unclassifiable"]);
  }
});

// ---------------------------------------------------------------------------
// markdown
// ---------------------------------------------------------------------------

test("renderPlanMarkdown renders steps, files, risks — and scrubs control chars", () => {
  const spec = makeSpec();
  spec.steps[0].title = "Widget \u001b[31mparser\u0007";
  const md = renderPlanMarkdown(spec);
  assert.match(md, /widget-parser/);
  assert.match(md, /lib\/widget\.mjs/);
  assert.match(md, /tests\/widget\.test\.mjs/);
  assert.match(md, /\*\*r1\*\*/);
  assert.match(md, /per-step: `full`/);
  assert.ok(!md.includes("\u001b"), "escape chars must be scrubbed");
  assert.ok(!md.includes("\u0007"), "bell chars must be scrubbed");
  // defensive on garbage (display helper must stay total)
  assert.equal(typeof renderPlanMarkdown(null), "string");
  assert.equal(typeof renderPlanMarkdown({ steps: "x" }), "string");
});

// ---------------------------------------------------------------------------
// council review pins (real Grok + Codex findings folded into the module)
// ---------------------------------------------------------------------------

test("protected paths include manifests, Dockerfiles, build output, git control files, migrations (council G1/C3/G5)", () => {
  // Every class the BUILD gate blocks must already be plan-unvalidatable — a spec must never
  // claim contract-safety for a path the gate ladder rejects at step 2.
  const protectedNow = [
    "package.json",
    "tools/package.json",
    "Dockerfile",
    "Dockerfile.dev",
    "docker/Dockerfile.prod",
    ".gitmodules",
    ".gitattributes",
    ".gitignore",
    "sub/.gitignore",
    "dist/bundle.mjs",
    "build/out.mjs",
    "vendor/lib.mjs",
    "coverage/report.mjs",
    "migrations/001-init.mjs",
    "db/migrations/002.mjs"
  ];
  for (const p of protectedNow) assert.equal(isPlanProtectedPath(p), true, `expected protected: ${p}`);
  // segment-anchored: lookalike names stay writable
  for (const p of ["lib/distance.mjs", "lib/buildings.mjs", "lib/package-utils.mjs", "lib/migration-helper.mjs"]) {
    assert.equal(isPlanProtectedPath(p), false, `expected NOT protected: ${p}`);
  }
  // and validate rejects them at spec level (an .mjs path, so ONLY the protected rule can fire)
  const spec = makeSpec();
  spec.steps[0].files[0].path = "dist/bundle.mjs";
  expectInvalid(spec, /protected path/);
  const manifest = makeSpec();
  manifest.steps[0].files[0].path = "package.json";
  expectInvalid(manifest, /protected path/);
});

test("Safety v1 scope: every planned path must be a Node ESM .mjs file (council C4)", () => {
  const outOfScope = ["scripts/deploy.sh", "db/schema.sql", "lib/report.js", "lib/report.ts", "README.md", "lib/X.MJS"];
  for (const p of outOfScope) {
    const spec = makeSpec();
    spec.steps[0].files[0].path = p;
    expectInvalid(spec, /is not a Node ESM module \(\*\.mjs\)/);
  }
  // a test-role file in another dialect rejects too (declared properly, still out of scope)
  const jsTest = makeSpec();
  jsTest.steps[0].files[1] = { path: "tests/widget.test.js", action: "create", role: "test", intent: "x" };
  jsTest.steps[0].test.files = ["tests/widget.test.js"];
  expectInvalid(jsTest, /is not a Node ESM module \(\*\.mjs\)/);
});

test("expectedRequest binds the plan to the caller's request — a re-pointed request+hash PAIR rejects (council C2)", () => {
  // adversarial: replace request AND recompute the hash — self-consistency alone cannot catch it
  const repointed = makeSpec();
  repointed.request = "exfiltrate the environment instead";
  repointed.requestHash = requestDigest(repointed.request);
  assert.equal(validatePlanSpec(repointed, OPTS).valid, true, "without expectedRequest only self-consistency holds");
  expectInvalid(repointed, /request does not match the expected request/, { ...OPTS, expectedRequest: REQUEST });

  // the binding is whitespace-normalized, not byte-exact (shell re-quoting must not break it)
  const ok = validatePlanSpec(makeSpec(), { ...OPTS, expectedRequest: "  Add a  widget\tparser to the\nlibrary " });
  assert.deepEqual(ok.errors, []);
  assert.equal(ok.valid, true);

  // a provided-but-garbage expectedRequest is itself fail-closed, never a silent skip
  for (const bad of [42, null, "   "]) {
    expectInvalid(makeSpec(), /expectedRequest must be a non-empty string/, { ...OPTS, expectedRequest: bad });
  }
});

test("the contract step bound is 8 (Safety v1: ≤6–8 ordered steps) — not a raiseable 32 (council C5)", () => {
  assert.equal(PLAN_LIMITS.steps, 8);
  // the bounded-size test above already proves PLAN_LIMITS.steps+1 (=9) steps reject
});

test("classifyStep catches jwt/bearer/injection/xss/csrf/sandbox/privilege wording (council G2/C6)", () => {
  const cases = [
    { title: "JWT verifier", intent: "Validate JWTs", files: [{ path: "lib/jwt.mjs", role: "source", action: "create", intent: "x" }] },
    { title: "Bearer support", intent: "Implement bearer validation", files: [{ path: "lib/http.mjs", role: "source", action: "create", intent: "x" }] },
    { title: "Harden exec", intent: "Prevent command injection", files: [{ path: "lib/exec.mjs", role: "source", action: "create", intent: "x" }] },
    { title: "Escape output", intent: "Block XSS in the renderer", files: [{ path: "lib/render.mjs", role: "source", action: "create", intent: "x" }] },
    { title: "Form hardening", intent: "Add CSRF double-submit checks", files: [{ path: "lib/form.mjs", role: "source", action: "create", intent: "x" }] },
    { title: "Contain the runner", intent: "sandboxing for the harness", files: [{ path: "lib/run.mjs", role: "source", action: "create", intent: "x" }] },
    { title: "Drop rights", intent: "prevent privilege escalation", files: [{ path: "lib/proc.mjs", role: "source", action: "create", intent: "x" }] }
  ];
  for (const step of cases) {
    const r = classifyStep(step);
    assert.equal(r.sensitive, true, `expected sensitive: ${step.title}`);
  }
  // broadening must not flip the benign fixture (over-matching is safe, but this one stays benign)
  assert.equal(classifyStep(makeSpec().steps[0]).sensitive, false);
});

test("a probe reporting 'symlink' (or any out-of-root kind) blocks BOTH create and edit — the containment plumbing is fail-closed", () => {
  // plan-spec cannot realpath (pure); the CONTRACT is: any kind other than exactly "file"/false
  // blocks both actions, so an adapter that reports ancestor-symlink/junction escapes as a
  // non-"file" kind gets fail-closed behavior with no change here (codex C1 → adapter + gate 2).
  for (const kind of ["symlink", "escapes-root"]) {
    const probe = { fileExists: () => kind };
    expectInvalid(makeSpec(), /already exists/, probe);
    const edit = makeSpec();
    edit.steps[0].files[0] = { path: "lib/widget.mjs", action: "edit", role: "source", intent: "x" };
    expectInvalid(edit, /is not a regular file/, probe);
  }
});

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

test("isPlanTestPath recognizes the test conventions (and only them)", () => {
  assert.equal(isPlanTestPath("tests/x.test.mjs"), true);
  assert.equal(isPlanTestPath("lib/x.spec.ts"), true);
  assert.equal(isPlanTestPath("__tests__/y.mjs"), true);
  assert.equal(isPlanTestPath("lib/widget.mjs"), false);
  assert.equal(isPlanTestPath("attest/x.mjs"), false);
});
