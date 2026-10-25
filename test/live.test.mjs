// Live: real registry lookups. Run with SLOPSQUAT_LIVE=1, ideally with a fresh
// HOME so the disk cache (~/.failproofai/slopsquat/cache) is cold, e.g.
//   SLOPSQUAT_LIVE=1 HOME=$(mktemp -d) node --import ./test/register-stub.mjs --test test/live.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { policy } from "./failproofai-stub.mjs";
import { lookup } from "../slopsquat.mjs";

const live = process.env.SLOPSQUAT_LIVE === "1";
const opts = { skip: !live && "set SLOPSQUAT_LIVE=1", timeout: 20_000 };

const install = policy("slopsquat-install-guard");
const manifest = policy("slopsquat-manifest-guard");
const bash = (command, params) => install.fn({ toolName: "Bash", toolInput: { command }, session: { cwd: tmpdir() }, params });
const fake = (eco) => `slopsquat-test-${eco}-${randomUUID().slice(0, 8)}`;

const REAL = [
  ["npm", "npm install lodash"],
  ["pypi", "pip install requests"],
  ["cargo", "cargo add serde"],
  ["go", "go get github.com/pkg/errors@v0.9.1"],
  ["go (package inside a module)", "go install golang.org/x/tools/cmd/stringer@latest"],
  ["gem", "gem install rails"],
];

for (const [label, command] of REAL) {
  test(`live allow: ${label}`, opts, async () => {
    const r = await bash(command);
    assert.equal(r.decision, "allow", r.reason);
  });
}

const MISSING = [
  ["npm", () => `npm install ${fake("npm")}`],
  ["npm scoped", () => `npm install @slopsquat-test/${fake("x")}`],
  ["pypi", () => `pip install ${fake("pypi")}`],
  ["cargo", () => `cargo add ${fake("cargo")}`],
  ["go", () => `go get github.com/slopsquat-test/${fake("go")}@latest`],
  ["gem", () => `gem install ${fake("gem")}`],
];

for (const [label, make] of MISSING) {
  test(`live deny: ${label}`, opts, async () => {
    const r = await bash(make());
    assert.equal(r.decision, "deny", r.reason);
    assert.match(r.reason, /^Slopsquatting guard blocked this install: .* not exist on /);
  });
}

test("live deny: the real package passes and only the fake one is named", opts, async () => {
  const bad = fake("npm");
  const r = await bash(`npm i react ${bad}`);
  assert.equal(r.decision, "deny");
  assert.ok(r.reason.includes(`\`${bad}\``));
  assert.ok(!r.reason.includes("`react`"));
});

test("live warn: thresholds from params pause a real package once", opts, async () => {
  // A 30-year age floor makes any real package "too new", which exercises the
  // warn (pause once) path on live metadata.
  const r = await bash("cargo add anyhow", { minAgeDays: 365 * 30 });
  assert.equal(r.decision, "deny");
  assert.match(r.reason, /^PAUSED by the slopsquat guard\..*`anyhow` on crates\.io was first published .*run the same command again/);
});

test("live manifest: adding a fake dependency to package.json is denied", opts, async () => {
  const bad = fake("npm");
  const r = await manifest.fn({
    toolName: "Write",
    toolInput: { file_path: `${tmpdir()}/slopsquat-live-${randomUUID()}/package.json`, content: JSON.stringify({ dependencies: { lodash: "^4", [bad]: "^1" } }) },
    session: { cwd: tmpdir() },
  });
  assert.equal(r.decision, "deny");
  assert.ok(r.reason.includes("blocked this edit to package.json: `"));
});

test("live metadata: field names still match the registries", opts, async () => {
  const signal = AbortSignal.timeout(15_000);
  const pypi = await lookup("pypi", "requests", signal);
  assert.equal(pypi.status, "ok");
  assert.ok(pypi.createdAt < Date.parse("2012-01-01"), "PyPI upload_time_iso_8601");
  assert.ok(pypi.versionCount > 100 && pypi.hasRepo);
  const crate = await lookup("cargo", "anyhow", signal);
  assert.ok(crate.createdAt && crate.downloads > 1e6 && crate.hasRepo, "crates.io created_at/downloads/repository");
  const go = await lookup("go", "golang.org/x/tools/cmd/stringer", signal);
  assert.equal(go.module, "golang.org/x/tools");
});

test("live budget: twelve cold lookups across every registry finish inside the deadline", opts, async () => {
  const command = [
    `npm i ${fake("npm")} express-session-${randomUUID().slice(0, 4)} chalk`,
    `pip install ${fake("pypi")} flask boto3`,
    `cargo add ${fake("cargo")} tokio`,
    `go get github.com/${fake("go")}/x@latest`,
    `gem install ${fake("gem")} sidekiq`,
    "bundle add puma",
  ].join(" && ");
  const started = Date.now();
  const r = await bash(command);
  const ms = Date.now() - started;
  console.log(`# twelve-package check took ${ms}ms -> ${r.decision}`);
  assert.equal(r.decision, "deny");
  assert.ok(ms < 8000, `took ${ms}ms`);
});
