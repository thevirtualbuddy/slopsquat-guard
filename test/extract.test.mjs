// Offline: command parsing, manifest diffing and the assessment rules.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { registered } from "./failproofai-stub.mjs";
import {
  addedDependencies,
  assess,
  check,
  extractFromCommand,
  extractFromManifestEdit,
} from "../slopsquat.mjs";

const names = (cmd) => extractFromCommand(cmd).map((p) => `${p.eco}:${p.name}`);

const COMMANDS = [
  // npm family
  ["npm install lodash", ["npm:lodash"]],
  ["npm i -D typescript @types/node@^20", ["npm:typescript", "npm:@types/node"]],
  ["npm isntall left-pad", ["npm:left-pad"]],
  ["npm --prefix web install react", ["npm:react"]],
  ["npm install", []],
  ["npm ci", []],
  ["npm run build", []],
  ["npm install ./local-pkg ../other file:../x", []],
  ["npm install git+https://github.com/a/b.git github:a/b a/b https://x.io/p.tgz", []],
  ["npm install --registry https://npm.acme.dev private-thing", []],
  ["npm_config_registry=https://npm.acme.dev npm i private-thing", []],
  ["npm install my-alias@npm:real-pkg@1", ["npm:real-pkg"]],
  ["npm i lodash > install.log 2>&1", ["npm:lodash"]],
  ["npx -y create-vite@latest my-app --template react", ["npm:create-vite"]],
  ["npx -p @scope/tool -p other run-it", ["npm:@scope/tool", "npm:other"]],
  ["npm exec -- cowsay hi", ["npm:cowsay"]],
  ["yarn add express", ["npm:express"]],
  ["yarn global add serve", ["npm:serve"]],
  ["yarn dlx degit user/repo", ["npm:degit"]],
  ["yarn install", []],
  ["pnpm add -D vitest", ["npm:vitest"]],
  ["pnpm dlx tsx script.ts", ["npm:tsx"]],
  ["pnpm install", []],
  ["bun add zod", ["npm:zod"]],
  ["bunx prettier --write .", ["npm:prettier"]],
  // PyPI family
  ["pip install requests", ["pypi:requests"]],
  ["pip3 install 'Flask[async]>=2.0' Django_Rest-Framework", ["pypi:flask", "pypi:django-rest-framework"]],
  ["python3 -m pip install --upgrade pip setuptools", ["pypi:pip", "pypi:setuptools"]],
  ["python -m pip install -r requirements.txt", []],
  ["pip install -e .", []],
  ["pip install .", []],
  ["pip install -i https://pypi.acme.dev/simple internal-lib", []],
  ["PIP_INDEX_URL=https://pypi.acme.dev pip install internal-lib", []],
  ["pip install --extra-index-url https://pypi.acme.dev/simple numpy", ["pypi:numpy"]],
  ["pip install ./dist/pkg-1.0-py3-none-any.whl", []],
  ["pip install 'pkg @ git+https://github.com/a/b'", []],
  ["uv add httpx", ["pypi:httpx"]],
  ["uv pip install pandas", ["pypi:pandas"]],
  ["uv tool install ruff", ["pypi:ruff"]],
  ["uvx ruff check .", ["pypi:ruff"]],
  ["uvx --from httpie http GET example.com", ["pypi:httpie"]],
  ["uv run --with rich,typer script.py", ["pypi:rich", "pypi:typer"]],
  ["uv run pytest", []],
  ["uv sync", []],
  ["poetry add fastapi@^0.110 uvicorn", ["pypi:fastapi", "pypi:uvicorn"]],
  ["pdm add attrs", ["pypi:attrs"]],
  ["pipx install black", ["pypi:black"]],
  ["pipx run cowsay hello", ["pypi:cowsay"]],
  ["pipenv install requests", ["pypi:requests"]],
  // Cargo
  ["cargo add serde@1 tokio --features full", ["cargo:serde", "cargo:tokio"]],
  ["cargo install ripgrep", ["cargo:ripgrep"]],
  ["cargo install --path .", []],
  ["cargo add --git https://github.com/a/b b", []],
  ["cargo build", []],
  // Go
  ["go get github.com/pkg/errors@v0.9.1", ["go:github.com/pkg/errors"]],
  ["go install golang.org/x/tools/gopls@latest", ["go:golang.org/x/tools/gopls"]],
  ["go get -u ./...", []],
  ["go run main.go", []],
  ["go run github.com/a/tool@v1.2.0", ["go:github.com/a/tool"]],
  ["go build ./...", []],
  // RubyGems
  ["gem install rails -v 7.1.0", ["gem:rails"]],
  ["gem install bundler:2.5.0", ["gem:bundler"]],
  ["bundle add sidekiq --version '~> 7'", ["gem:sidekiq"]],
  ["gem install --source https://gems.acme.dev secret", []],
  ["bundle install", []],
  // Shell plumbing
  ["cd web && npm install axios; pip install rich", ["npm:axios", "pypi:rich"]],
  ["sudo -u deploy npm install -g pm2", ["npm:pm2"]],
  ["FOO=1 BAR=\"$X\" pip install httpx", ["pypi:httpx"]],
  ["bash -lc 'pip install pydantic'", ["pypi:pydantic"]],
  ["pip install $PKG", []],
  ["npm install \"$(cat pkgname)\"", []],
  ["echo 'npm install not-a-command'", []],
  ["cat > README.md <<'EOF'\nRun `pip install my-unreleased-thing` to start.\nEOF\nls", []],
  ["git commit -m 'go get going'", []],
  ["ls -la # npm install foo", []],
];

for (const [cmd, expected] of COMMANDS) {
  test(`command: ${cmd.split("\n")[0]}`, () => {
    assert.deepEqual(names(cmd), expected);
  });
}

const MANIFESTS = [
  [
    "npm",
    JSON.stringify({ dependencies: { react: "^18.0.0" } }),
    JSON.stringify({
      dependencies: { react: "^18.0.0", zod: "^3", local: "file:../local", gh: "user/repo" },
      devDependencies: { "@types/react": "^18", alias: "npm:real-thing@^1" },
    }),
    ["npm:zod", "npm:@types/react", "npm:real-thing"],
  ],
  ["npm", "{}", "{ not json", []],
  [
    "requirements",
    "requests==2.31\n",
    "requests==2.31\n# comment\n-r base.txt\nFlask[async]>=2  # web\n./local\nhttpx @ https://x/y.whl\n",
    ["pypi:flask"],
  ],
  [
    "pyproject",
    '[project]\nname = "app"\ndependencies = ["requests"]\n',
    '[project]\nname = "app"\ndependencies = [\n  "requests",\n  "httpx>=0.27",  # client\n]\n\n[project.optional-dependencies]\ndev = ["pytest"]\n\n[tool.poetry.dependencies]\npython = "^3.11"\nfastapi = "^0.110"\nmylib = { path = "../mylib" }\n',
    ["pypi:httpx", "pypi:pytest", "pypi:fastapi"],
  ],
  [
    "cargo",
    '[package]\nname = "x"\n\n[dependencies]\nserde = "1"\n',
    '[package]\nname = "x"\n\n[dependencies]\nserde = "1"\ntokio = { version = "1", features = ["full"] }\nlocal = { path = "../local" }\nshared = { workspace = true }\nrenamed = { package = "real-crate", version = "1" }\n\n[dev-dependencies.criterion]\nversion = "0.5"\n',
    ["cargo:tokio", "cargo:real-crate", "cargo:criterion"],
  ],
  [
    "go",
    "module x\n\ngo 1.22\n\nrequire github.com/pkg/errors v0.9.1\n",
    "module x\n\ngo 1.22\n\nrequire github.com/pkg/errors v0.9.1\n\nrequire (\n\tgolang.org/x/sync v0.7.0\n\texample.com/local v0.0.0 // indirect\n)\n\nreplace example.com/local => ../local\n",
    ["go:golang.org/x/sync"],
  ],
  [
    "gem",
    "source 'https://rubygems.org'\ngem 'rails'\n",
    "source 'https://rubygems.org'\ngem 'rails'\ngem \"sidekiq\", \"~> 7\"\ngem 'mine', path: '../mine'\nsource 'https://gems.acme.dev' do\n  gem 'secret'\nend\ngroup :test do\n  gem 'rspec'\nend\n",
    ["gem:sidekiq", "gem:rspec"],
  ],
];

for (const [kind, before, after, expected] of MANIFESTS) {
  test(`manifest diff: ${kind} ${expected.join(",") || "(none)"}`, () => {
    assert.deepEqual(
      addedDependencies(kind, before, after).map((p) => `${p.eco}:${p.name}`),
      expected,
    );
  });
}

test("manifest edit: Edit applies old_string -> new_string to the file on disk", () => {
  const dir = mkdtempSync(join(tmpdir(), "slopsquat-test-"));
  const file = join(dir, "package.json");
  writeFileSync(file, JSON.stringify({ dependencies: { react: "^18" } }, null, 2));
  const got = extractFromManifestEdit(
    "Edit",
    { file_path: file, old_string: '"react": "^18"', new_string: '"react": "^18",\n    "left-pad": "^1"' },
    dir,
  );
  assert.deepEqual(got, [{ eco: "npm", name: "left-pad" }]);
});

test("manifest edit: MultiEdit and a relative path resolved against cwd", () => {
  const dir = mkdtempSync(join(tmpdir(), "slopsquat-test-"));
  writeFileSync(join(dir, "requirements.txt"), "requests\n");
  const got = extractFromManifestEdit(
    "MultiEdit",
    { file_path: "requirements.txt", edits: [{ old_string: "requests\n", new_string: "requests\nrich\n" }, { old_string: "rich\n", new_string: "rich\ntyper\n" }] },
    dir,
  );
  assert.deepEqual(got.map((p) => p.name), ["rich", "typer"]);
});

test("manifest edit: Write of a new manifest counts every dependency", () => {
  const dir = mkdtempSync(join(tmpdir(), "slopsquat-test-"));
  const got = extractFromManifestEdit("Write", { file_path: join(dir, "Cargo.toml"), content: '[dependencies]\nanyhow = "1"\n' }, dir);
  assert.deepEqual(got, [{ eco: "cargo", name: "anyhow" }]);
});

test("manifest edit: files that are not manifests are ignored", () => {
  assert.deepEqual(extractFromManifestEdit("Write", { file_path: "/tmp/notes.md", content: "pip install x" }, "/tmp"), []);
});

// ---- assessment -------------------------------------------------------------

const NOW = Date.parse("2026-10-25T00:00:00Z");
const daysAgo = (n) => NOW - n * 86_400_000;

test("assess: missing and lookup errors", () => {
  assert.equal(assess("npm", { status: "missing" }).verdict, "missing");
  assert.equal(assess("npm", { status: "error", error: "timed out" }).verdict, "unknown");
});

test("assess: an established package is ok", () => {
  const r = assess("npm", { status: "ok", downloads: 5_000_000 }, undefined, NOW);
  assert.deepEqual(r, { verdict: "ok", reasons: [] });
});

test("assess: a days-old npm package with an install script is suspicious", () => {
  const r = assess("npm", { status: "ok", downloads: 3, createdAt: daysAgo(2), versionCount: 1, hasRepo: false, installScripts: true }, undefined, NOW);
  assert.equal(r.verdict, "suspicious");
  assert.deepEqual(r.reasons, [
    "was first published 2 days ago",
    "had 3 downloads last week",
    "has a single release and no linked source repository",
    "runs an install script",
  ]);
});

test("assess: an old, niche package with a repo is not flagged for low traffic", () => {
  const r = assess("npm", { status: "ok", downloads: 4, createdAt: daysAgo(2000), versionCount: 6, hasRepo: true }, undefined, NOW);
  assert.equal(r.verdict, "ok");
});

test("assess: a PyPI placeholder with no files is suspicious", () => {
  const r = assess("pypi", { status: "ok", createdAt: null, versionCount: 0, hasRepo: false, noFiles: true }, undefined, NOW);
  assert.equal(r.verdict, "suspicious");
});

test("assess: thresholds come from params", () => {
  const meta = { status: "ok", createdAt: daysAgo(20), versionCount: 4, hasRepo: true };
  assert.equal(assess("cargo", meta, { ...DEFAULTS_FOR_TEST(), minAgeDays: 30 }, NOW).verdict, "suspicious");
  assert.equal(assess("cargo", meta, DEFAULTS_FOR_TEST(), NOW).verdict, "ok");
});

function DEFAULTS_FOR_TEST() {
  return { minAgeDays: 14, minWeeklyDownloadsNpm: 50, minTotalDownloads: 1000, freshWindowDays: 90 };
}

// ---- policy wiring (no network: everything here is skipped before lookup) -----

test("both policies register on PreToolUse", () => {
  const byName = Object.fromEntries(registered.map((p) => [p.name, p]));
  assert.deepEqual(Object.keys(byName).sort(), ["slopsquat-install-guard", "slopsquat-manifest-guard"]);
  for (const p of registered) assert.deepEqual(p.match.events, ["PreToolUse"]);
});

test("install guard ignores tools other than Bash and commands with no installs", async () => {
  const p = registered.find((r) => r.name === "slopsquat-install-guard");
  assert.equal((await p.fn({ toolName: "Read", toolInput: { file_path: "x" } })).decision, "allow");
  assert.equal((await p.fn({ toolName: "Bash", toolInput: { command: "ls -la" } })).decision, "allow");
});

test("allow list and private prefixes skip the lookup entirely", async () => {
  const cfg = { ...DEFAULTS_FOR_TEST(), allow: ["pypi:internal-tool"], allowPrefixes: ["@acme/"], maxPackages: 12, deadlineMs: 1, requestTimeoutMs: 1, onLookupError: "instruct" };
  const r = await check([{ eco: "npm", name: "@acme/ui" }, { eco: "pypi", name: "internal-tool" }], { cfg, cwd: tmpdir() });
  assert.equal(r.decision, "allow");
});

test("npx of a bin that exists locally is not looked up", async () => {
  const dir = mkdtempSync(join(tmpdir(), "slopsquat-test-"));
  mkdirSync(join(dir, "node_modules", ".bin"), { recursive: true });
  writeFileSync(join(dir, "node_modules", ".bin", "my-local-cli"), "");
  const cfg = { ...DEFAULTS_FOR_TEST(), allow: [], allowPrefixes: [], maxPackages: 12, deadlineMs: 1, requestTimeoutMs: 1, onLookupError: "instruct" };
  const r = await check(extractFromCommand("npx my-local-cli --help"), { cfg, cwd: dir });
  assert.equal(r.decision, "allow");
});
