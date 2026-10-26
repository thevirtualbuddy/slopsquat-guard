// The demo without an agent: feeds each scene's tool call straight to the
// policy, against the real registries, and prints what the agent would get.
// Use it to see each scene's outcome without an agent, or to check the
// registries and the policy before a live session.
//
//   node --import ./test/register-stub.mjs demo/dry-run.mjs
//
// Needs demo/scenes.json (from demo/setup.sh or `node demo/preflight.mjs`).

import { readFileSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";

// Pauses are remembered under HOME; use a scratch one so a dry run never
// pre-approves anything for a real session.
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

async function step(title, label, call, note) {
  const started = Date.now();
  const r = await call();
  if (title) console.log(`\n${c("1", title)}`);
  console.log(`  ${c("2", "agent:")} ${label}`);
  console.log(`  ${badge(r.decision, r.reason)} ${c("2", `${Date.now() - started}ms`)}`);
  if (r.reason) console.log(c("2", wrap(r.reason)));
  if (note) console.log(c("36", wrap(note)));
}

const bash = (command) => () => install.fn({ toolName: "Bash", toolInput: { command }, session });

await step("Scene 1 · Day 0: the name doesn't exist", `npm install ${scenes.fakeNpm}`, bash(`npm install ${scenes.fakeNpm}`));
await step(null, "npm install express-jwt   (the agent reads why, picks the real package)", bash("npm install express-jwt"));

const freshCmd = `npm install --dry-run --ignore-scripts ${scenes.fresh.name}`;
await step(`Scene 2 · Day 1: the name gets registered  (${scenes.fresh.name}, ${scenes.fresh.ageDays} day(s) old)`, freshCmd, bash(freshCmd));
await step(null, `${freshCmd}   (you said yes; the agent retries)`, bash(freshCmd));

await step("Scene 3 · Not just the shell", `Edit package.json: add "${scenes.fakeNpm2}"`, () =>
  manifest.fn({
    toolName: "Edit",
    toolInput: { file_path: join(project, "package.json"), old_string: '"express": "^4.21.0"', new_string: `"express": "^4.21.0",\n    "${scenes.fakeNpm2}": "^1.0.0"` },
    session,
  }),
);

await step(
  "Scene 4 · The limit",
  "bash scripts/bootstrap.sh",
  bash("bash scripts/bootstrap.sh"),
  `The guard only sees the command the agent runs, not what is inside the script, so the \`npm install ${scenes.fakeNpm}\` in bootstrap.sh is never checked. Today npm just 404s; the day someone registers the name, it installs.`,
);

if (scenes.fakePypi) {
  await step("Optional · Same guard, Python", `pip install ${scenes.fakePypi}`, bash(`pip install ${scenes.fakePypi}`));
}
console.log();
