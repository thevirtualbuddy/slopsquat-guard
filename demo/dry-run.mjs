// The demo without an agent: feeds each scene's tool call straight to the
// policy, against the real registries, and prints what the agent would get.
// Use it to rehearse, to record a clean take, or as the fallback if a live
// agent wanders off-script.
//
//   node --import ./test/register-stub.mjs demo/dry-run.mjs
//
// Needs demo/scenes.json (from `node demo/preflight.mjs` or demo/setup.sh).

import { readFileSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";

// Pauses are remembered under HOME; use a scratch one so a rehearsal never
// pre-approves anything for the real demo.
process.env.HOME = mkdtempSync(join(tmpdir(), "slopsquat-dryrun-"));

const HERE = dirname(fileURLToPath(import.meta.url));
const scenes = JSON.parse(readFileSync(join(HERE, "scenes.json"), "utf8"));
const { policy } = await import("../test/failproofai-stub.mjs");
await import("../slopsquat.mjs");
const install = policy("slopsquat-install-guard");
const manifest = policy("slopsquat-manifest-guard");

const project = mkdtempSync(join(tmpdir(), "slopsquat-dryrun-project-"));
writeFileSync(join(project, "package.json"), JSON.stringify({ name: "demo", dependencies: { express: "^4.21.0" } }, null, 2));
const session = { cwd: project, sessionId: `dry-run-${randomUUID()}` };

const tty = process.stdout.isTTY;
const c = (code, s) => (tty ? `\x1b[${code}m${s}\x1b[0m` : s);
const badge = (d, reason = "") =>
  d === "allow" ? c("42;30", " ALLOWED ") : reason.startsWith("PAUSED") ? c("43;30", " PAUSED ") : c("41;97", " BLOCKED ");
const wrap = (s, width = 76) => s.replace(new RegExp(`(.{1,${width}})(\\s+|$)`, "g"), "    $1\n").trimEnd();

async function step(title, label, call) {
  const started = Date.now();
  const r = await call();
  console.log(`\n${c("1", title)}`);
  console.log(`  ${c("2", "agent:")} ${label}`);
  console.log(`  ${badge(r.decision, r.reason)} ${c("2", `${Date.now() - started}ms`)}`);
  if (r.reason) console.log(c("2", wrap(r.reason)));
}

const bash = (command) => () => install.fn({ toolName: "Bash", toolInput: { command }, session });

await step("Scene 1 · hallucinated package", `npm install ${scenes.fakeNpm}`, bash(`npm install ${scenes.fakeNpm}`));
await step("        · the agent finds the real one", "npm install express-jwt jsonwebtoken", bash("npm install express-jwt jsonwebtoken"));

const freshCmd = `npm install --dry-run --ignore-scripts ${scenes.fresh.name}`;
await step(`Scene 2 · brand-new package (${scenes.fresh.ageDays} day(s) old)`, freshCmd, bash(freshCmd));
await step("        · you confirm, the agent retries", freshCmd, bash(freshCmd));

await step("Scene 3 · hallucinated dependency edited into package.json", `Edit package.json: add "${scenes.fakeNpm2}"`, () =>
  manifest.fn({
    toolName: "Edit",
    toolInput: { file_path: join(project, "package.json"), old_string: '"express": "^4.21.0"', new_string: `"express": "^4.21.0",\n    "${scenes.fakeNpm2}": "^1.0.0"` },
    session,
  }),
);

await step("Scene 4 · same guard, Python", `pip install ${scenes.fakePypi}`, bash(`pip install ${scenes.fakePypi}`));
console.log();
