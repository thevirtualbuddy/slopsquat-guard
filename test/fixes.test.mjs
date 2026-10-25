// Offline regression tests for the review fixes: pause-once warnings, the
// per-call overflow, public-registry flags, eval / xargs / variable names,
// lookup-error modes, Go untagged wording, cache location, params schema and
// the never-throw wrapper. A fake registry stands in for the network.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

// Everything the policy writes goes under this HOME, never the real one.
const HOME = mkdtempSync(join(tmpdir(), "slopsquat-home-"));
process.env.HOME = HOME;
delete process.env.GOPROXY;
delete process.env.npm_config_registry;
delete process.env.NPM_CONFIG_REGISTRY;

const { policy } = await import("./failproofai-stub.mjs");
const { inspectCommand, extractFromCommand, isPublicRegistry, isPublicGoproxy } = await import("../slopsquat.mjs");
const install = policy("slopsquat-install-guard");
const manifest = policy("slopsquat-manifest-guard");

// ---- fake registry -------------------------------------------------------
// evil-*  : 2 days old, 2 downloads, one release, no repo, postinstall script
// ghost-* : does not exist
// flaky-* : the registry errors
// anything else: established
const DAY = 86_400_000;
const ago = (d) => new Date(Date.now() - d * DAY).toISOString();
const res = (status, body, text) => ({ ok: status < 300, status, json: async () => body, text: async () => text ?? JSON.stringify(body) });
const fetched = [];
const blipped = new Set();
const socketError = () => Object.assign(new TypeError("fetch failed"), { cause: { code: "UND_ERR_SOCKET", message: "other side closed" } });
globalThis.fetch = async (url, opts = {}) => {
  const u = String(url);
  fetched.push(u);
  const last = decodeURIComponent(u.split("/").pop().replace(/\.json$/, "").replace(/\?.*$/, ""));
  const has = (p) => u.includes(p);
  if (has("flaky-")) throw socketError();
  // blip-*: the first request to each URL drops (a stale kept-alive socket), the retry works
  if (has("blip-") && !blipped.has(u)) {
    blipped.add(u);
    throw socketError();
  }
  if (has("ghost-")) return res(404, { error: "not found" }, "not found");
  // npm
  if (u.startsWith("https://registry.npmjs.org/") && opts.method === "HEAD") return res(200, {});
  if (has("api.npmjs.org/downloads")) return res(200, { downloads: last.startsWith("evil") ? 2 : 2_000_000 });
  if (u.startsWith("https://registry.npmjs.org/")) {
    return res(200, { time: { created: ago(2) }, versions: { "1.0.0": { scripts: { postinstall: "node x.js" } } }, "dist-tags": { latest: "1.0.0" } });
  }
  // PyPI
  if (has("pypi.org/pypi/")) {
    // pypi.org/pypi/<name>/json: the name is the second-to-last segment
    return u.split("/").at(-2).startsWith("evil")
      ? res(200, { releases: { "0.1": [{ upload_time_iso_8601: ago(2) }] }, info: { project_urls: {} } })
      : res(200, { releases: { "1.0": [{ upload_time_iso_8601: "2015-01-01T00:00:00Z" }], "2.0": [{}] }, info: { project_urls: { Source: "https://github.com/x/y" } } });
  }
  // RubyGems
  if (has("rubygems.org/api/v1/gems/")) return res(200, last.startsWith("evil") ? { downloads: 5 } : { downloads: 10_000_000, source_code_uri: "https://github.com/x/y" });
  if (has("rubygems.org/api/v1/versions/")) return res(200, [{ created_at: ago(2) }]);
  // Go proxy
  if (has("proxy.golang.org/github.com/fresh/untagged/@latest")) return res(200, { Version: "v0.0.0-x", Time: ago(1) });
  if (has("proxy.golang.org/github.com/fresh/untagged/@v/list")) return res(200, null, "");
  if (has("proxy.golang.org/github.com/evil/") && has("@latest")) return res(200, { Version: "v0.1.0", Time: ago(2) });
  if (has("proxy.golang.org/github.com/evil/") && has("@v/list")) return res(200, null, "v0.1.0\n");
  if (has("proxy.golang.org/github.com/evil/") && has(".info")) return res(200, { Time: ago(2) });
  if (has("proxy.golang.org") && has("@latest")) return res(200, { Version: "v1.2.0", Time: "2018-01-01T00:00:00Z" });
  if (has("proxy.golang.org") && has("@v/list")) return res(200, null, "v1.0.0\nv1.1.0\nv1.2.0\n");
  throw new Error(`unexpected fetch ${u}`);
};

const sid = () => `s-${randomUUID()}`;
const uniq = (prefix) => `${prefix}-${randomUUID().slice(0, 8)}`;
const bash = (command, { session = sid(), params } = {}) =>
  install.fn({ toolName: "Bash", toolInput: { command }, session: { cwd: HOME, sessionId: session }, params });

// ---- 1. warn = pause once, then allow --------------------------------------

test("suspicious package: first attempt is paused, with the reasons and the retry rule", async () => {
  const r = await bash(`npm i ${uniq("evil")}`);
  assert.equal(r.decision, "deny");
  assert.match(r.reason, /^PAUSED by the slopsquat guard\. This is a warning, not a permanent block\./);
  assert.match(r.reason, /first published 2 days ago/);
  assert.match(r.reason, /runs an install script/);
  assert.match(r.reason, /run the same command again within 10 minutes/);
});

test("suspicious package: the same package retried in the same session goes through", async () => {
  const s = sid();
  const pkg = uniq("evil");
  assert.equal((await bash(`npm i ${pkg}`, { session: s })).decision, "deny");
  const again = await bash(`npm install --save-dev ${pkg}`, { session: s }); // different flags, same package
  assert.equal(again.decision, "allow");
  assert.match(again.reason, /proceeding after the earlier warning/);
});

test("suspicious package: a warning in one session does not clear another session", async () => {
  const pkg = uniq("evil");
  assert.equal((await bash(`npm i ${pkg}`)).decision, "deny");
  assert.equal((await bash(`npm i ${pkg}`)).decision, "deny");
});

test("suspicious package: once the window has passed, it pauses again", async () => {
  const s = sid();
  const pkg = uniq("evil");
  assert.equal((await bash(`npm i ${pkg}`, { session: s })).decision, "deny");
  // Age the stored pause past the window, in the file and the in-memory copy.
  const file = join(HOME, ".failproofai", "slopsquat", "pauses.json");
  const pauses = JSON.parse(readFileSync(file, "utf8"));
  const key = `${s}|npm:${pkg}`;
  assert.ok(pauses[key], "pause recorded on disk");
  pauses[key] = Date.now() - 11 * 60_000;
  writeFileSync(file, JSON.stringify(pauses));
  const r = await bash(`npm i ${pkg}`, { session: s });
  assert.equal(r.decision, "deny");
  assert.match(r.reason, /^PAUSED/);
});

test("only still-unconfirmed packages are listed on a mixed retry", async () => {
  const s = sid();
  const a = uniq("evil");
  const b = uniq("evil");
  await bash(`npm i ${a}`, { session: s });
  const r = await bash(`npm i ${a} ${b}`, { session: s });
  assert.equal(r.decision, "deny");
  assert.ok(r.reason.includes(`\`${b}\``));
  assert.ok(!r.reason.includes(`\`${a}\``));
});

test("manifest edits pause too, and clear on retry", async () => {
  const s = sid();
  const pkg = uniq("evil");
  const call = () =>
    manifest.fn({
      toolName: "Write",
      toolInput: { file_path: join(HOME, `proj-${s}`, "package.json"), content: JSON.stringify({ dependencies: { [pkg]: "^1" } }) },
      session: { cwd: HOME, sessionId: s },
    });
  const first = await call();
  assert.equal(first.decision, "deny");
  assert.match(first.reason, /^PAUSED.*edit to package\.json/);
  assert.equal((await call()).decision, "allow");
});

// ---- 2. missing names stay a hard block -------------------------------------

test("a name that does not exist is denied every time, never paused", async () => {
  const s = sid();
  const pkg = uniq("ghost");
  for (let i = 0; i < 2; i++) {
    const r = await bash(`npm i ${pkg}`, { session: s });
    assert.equal(r.decision, "deny");
    assert.match(r.reason, /^Slopsquatting guard blocked this install: .* does not exist on npm/);
  }
});

// ---- 3. overflow is never silently allowed ----------------------------------

test("a package past maxPackages is warned about, not skipped", async () => {
  const twelve = Array.from({ length: 12 }, (_, i) => `fine-pkg-${i}`).join(" ");
  const bad = uniq("evil");
  const r = await bash(`npm i ${twelve} ${bad}`);
  assert.equal(r.decision, "deny");
  assert.match(r.reason, new RegExp(`\`${bad}\` was not checked \\(over the 12-package per-call limit\\)`));
});

// ---- 4. pointing at the public registry is still checked --------------------

test("public registry flags and env vars do not switch the check off", () => {
  const cases = [
    ["npm i --registry https://registry.npmjs.org evil-x", "npm:evil-x"],
    ["npm i --registry=https://registry.npmjs.org/ evil-x", "npm:evil-x"],
    ["npm_config_registry=https://registry.npmjs.org/ npm i evil-x", "npm:evil-x"],
    ["npx --registry https://registry.yarnpkg.com evil-x", "npm:evil-x"],
    ["pip install -i https://pypi.org/simple evil-x", "pypi:evil-x"],
    ["PIP_INDEX_URL=https://pypi.org/simple pip install evil-x", "pypi:evil-x"],
    ["uv add --index-url https://pypi.org/simple evil-x", "pypi:evil-x"],
    ["GOPROXY=https://goproxy.io go get github.com/evil/x@latest", "go:github.com/evil/x"],
    ["GOPROXY=https://proxy.golang.org,direct go get github.com/evil/x", "go:github.com/evil/x"],
    ["gem install --source https://rubygems.org evil-x", "gem:evil-x"],
    ["cargo add --registry crates-io evil-x", "cargo:evil-x"],
  ];
  for (const [cmd, want] of cases) {
    assert.deepEqual(extractFromCommand(cmd).map((p) => `${p.eco}:${p.name}`), [want], cmd);
  }
});

test("private registries still skip the check", () => {
  for (const cmd of [
    "npm i --registry https://npm.acme.dev private-thing",
    "npm_config_registry=https://npm.acme.dev npm i private-thing",
    "pip install -i https://pypi.acme.dev/simple internal-lib",
    "GOPROXY=https://athens.acme.dev go get acme.dev/lib",
    "gem install --source https://gems.acme.dev secret",
    "cargo add --registry acme internal",
    "npm i --registry $REG thing",
  ]) {
    assert.deepEqual(extractFromCommand(cmd), [], cmd);
  }
});

test("registry host matching", () => {
  assert.ok(isPublicRegistry("npm", "https://registry.npmjs.org/"));
  assert.ok(isPublicRegistry("pypi", "https://pypi.org/simple"));
  assert.ok(!isPublicRegistry("npm", "https://registry.npmjs.org.evil.dev/"));
  assert.ok(!isPublicRegistry("pypi", "https://evil.dev/pypi.org/simple"));
  assert.ok(isPublicGoproxy("https://proxy.golang.org,direct"));
  assert.ok(!isPublicGoproxy("https://athens.acme.dev,direct"));
});

test("end to end: a public --registry flag no longer lets a risky package through", async () => {
  const r = await bash(`npm i --registry https://registry.npmjs.org ${uniq("evil")}`);
  assert.equal(r.decision, "deny");
  assert.match(r.reason, /^PAUSED/);
});

// ---- 5. eval, xargs and names built from variables --------------------------

test("eval and xargs are parsed", () => {
  assert.deepEqual(inspectCommand("eval 'npm i evil-x'").packages.map((p) => p.name), ["evil-x"]);
  assert.deepEqual(inspectCommand('eval "$(npm completion)"'), { packages: [], dynamic: [] });
  const x = inspectCommand("echo evil-h | xargs npm i");
  assert.equal(x.packages.length, 0);
  assert.equal(x.dynamic.length, 1);
  assert.match(x.dynamic[0].spec, /xargs/);
  assert.equal(inspectCommand("find . -name '*.log' | xargs rm").dynamic.length, 0);
});

test("a package name from a variable is surfaced, a version from a variable is not", () => {
  assert.deepEqual(inspectCommand("npm i $PKG").dynamic, [{ eco: "npm", spec: "$PKG" }]);
  assert.deepEqual(inspectCommand('pip install "$(cat name.txt)"').dynamic.length, 1);
  const v = inspectCommand("npm i lodash@$VERSION");
  assert.deepEqual(v.packages.map((p) => p.name), ["lodash"]);
  assert.equal(v.dynamic.length, 0);
  assert.deepEqual(inspectCommand("pip install dist/*.whl"), { packages: [], dynamic: [] });
});

test("end to end: xargs installs and variable names pause once", async () => {
  const s = sid();
  const r = await bash("cat deps.txt | xargs npm i", { session: s });
  assert.equal(r.decision, "deny");
  assert.match(r.reason, /only known when the command runs/);
  assert.equal((await bash("cat deps.txt | xargs npm i", { session: s })).decision, "allow");
});

// ---- 6. lookup errors follow onLookupError ----------------------------------

test("unverifiable lookups: warn by default, or allow / deny when configured", async () => {
  const pkg = uniq("flaky");
  const warn = await bash(`npm i ${pkg}`);
  assert.equal(warn.decision, "deny");
  assert.match(warn.reason, /^PAUSED.*could not be verified/);
  const allowed = await bash(`npm i ${uniq("flaky")}`, { params: { onLookupError: "allow" } });
  assert.equal(allowed.decision, "allow");
  assert.match(allowed.reason, /could not be verified/);
  const denied = await bash(`npm i ${uniq("flaky")}`, { params: { onLookupError: "deny" } });
  assert.equal(denied.decision, "deny");
  assert.match(denied.reason, /^Slopsquat guard blocked this install/);
  const legacy = await bash(`npm i ${uniq("flaky")}`, { params: { onLookupError: "instruct" } });
  assert.match(legacy.reason, /^PAUSED/, "the old 'instruct' value now means warn");
});

test("a dropped connection is retried once, so a transient blip does not pause", async () => {
  const pkg = uniq("blip");
  const r = await bash(`npm i ${pkg}`);
  assert.equal(r.decision, "allow", r.reason);
  assert.ok(fetched.filter((u) => u.includes(pkg)).length >= 3, "the failed request was repeated");
});

test("a persistent network error keeps its cause in the message", async () => {
  const r = await bash(`npm i ${uniq("flaky")}`);
  assert.match(r.reason, /could not be verified \(fetch failed: UND_ERR_SOCKET other side closed\)/);
});

test("HTTP errors are not retried", async () => {
  const before = fetched.length;
  await bash(`npm i ${uniq("ghost")}`);
  const calls = fetched.slice(before);
  assert.equal(new Set(calls).size, calls.length, "no URL was requested twice");
});

// ---- 7. Go untagged wording -------------------------------------------------

test("an untagged Go module is described by its latest code, not as first published", async () => {
  const r = await bash("go get github.com/fresh/untagged");
  assert.equal(r.decision, "deny");
  assert.match(r.reason, /has no tagged releases and its latest code was published 1 day ago/);
  assert.doesNotMatch(r.reason, /first published/);
});

test("an established Go module with several tags passes", async () => {
  assert.equal((await bash("go get github.com/old/mod@v1.2.0")).decision, "allow");
});

// ---- 8. other ecosystems still pause ---------------------------------------

test("PyPI and RubyGems risky packages pause", async () => {
  assert.match((await bash(`pip install ${uniq("evil")}`)).reason, /^PAUSED.*PyPI/);
  assert.match((await bash(`gem install ${uniq("evil")}`)).reason, /^PAUSED.*RubyGems/);
});

// ---- 9. cache location, params schema, never throws ------------------------

test("the cache lives under ~/.failproofai, not the shared temp folder", async () => {
  await bash(`npm i established-${randomUUID().slice(0, 6)}`);
  assert.ok(existsSync(join(HOME, ".failproofai", "slopsquat", "cache")));
});

test("both policies declare a params schema Failproof can validate", () => {
  for (const p of [install, manifest]) {
    assert.ok(p.params && typeof p.params === "object", p.name);
    for (const [k, spec] of Object.entries(p.params)) {
      assert.ok(["string", "number", "boolean", "string[]", "pattern[]"].includes(spec.type), `${k} type`);
      assert.ok(typeof spec.description === "string" && spec.description.length > 0, `${k} description`);
      assert.ok("default" in spec, `${k} default`);
    }
  }
});

test("an internal error never escapes the policy", async () => {
  const boom = { toString() { throw new Error("boom"); } };
  const r = await install.fn({ toolName: "Bash", toolInput: { command: boom }, session: {} });
  assert.equal(r.decision, "allow");
  assert.match(r.reason, /internal error \(boom\)/);
  const strict = await install.fn({ toolName: "Bash", toolInput: { command: boom }, session: {}, params: { onLookupError: "deny" } });
  assert.equal(strict.decision, "deny");
});
