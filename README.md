# slopsquat-guard

A [Failproof AI](https://github.com/FailproofAI/failproofai) policy pack that checks every package an AI agent
tries to install against its public registry, before the install runs.

Think of it as a bouncer for dependencies: a package that doesn't exist is turned away, one that's brand new or
barely used gets a second look, and established packages walk straight in.

## Why

AI models invent package names that sound right. Studies have found that roughly one in five packages recommended
by LLMs doesn't exist, and the same invented names tend to recur, so an attacker can register them in advance and
wait. This is **slopsquatting**. When researchers registered the hallucinated `huggingface-cli` as an empty
package, it was downloaded more than 30,000 times in three months.

A person might pause at an unfamiliar name. An agent with a shell just runs `npm install`. This pack sits on
exactly that step.

## Install

Requires failproofai **1.0.12** or newer, with hooks set up (`failproofai config`).

```bash
failproofai policies show thevirtualbuddy/slopsquat-guard   # read it first
failproofai policies add thevirtualbuddy/slopsquat-guard
```

Both policies are on by default and enforce for every agent harness Failproof supports.

## What it decides

| The package… | Result |
|---|---|
| doesn't exist on the registry, or was unpublished | 🛑 **Blocked**, every time. The agent is told to find the real name in the library's docs and not to try spelling variants. |
| exists but looks risky: new, low-traffic, install scripts, placeholder | ⏸️ **Paused once.** The first attempt is held with the reasons. The same package retried in the same session within 10 minutes goes through. |
| can't be verified: registry unreachable, name built from a variable, over 12 packages in one call | ⏸️ **Paused once** (configurable: `warn`, `allow` or `deny`) |
| looks established | ✅ **Allowed** |

### What counts as risky

| Signal | Applies to |
|---|---|
| First published fewer than **14** days ago | all registries |
| Fewer than **50** weekly downloads, and young (< 90 days) or no linked source repo | npm |
| Fewer than **1,000** total downloads, and young or no linked source repo | crates.io, RubyGems |
| Young, a single release, and no linked source repo | all registries |
| Young and runs an install script (`preinstall` / `install` / `postinstall`) | npm |
| No installable files: a placeholder registration | PyPI |

### Why "pause once" and not a warning

Failproof's `instruct()` lets a tool call run and attaches the message afterwards. For an install, that means the
package and its install script have already executed by the time the agent reads the warning. A pause holds the
first attempt, tells the agent to confirm with you, and lets the identical package through on the retry.

The pause is a speed bump, not a lock: an agent that ignores the instruction can simply retry.

## What it watches

| Ecosystem | Shell commands | Manifest edits |
|---|---|---|
| npm | `npm i/install/add`, `npm exec/x`, `npx`, `pnpm add/install/dlx`, `pnpx`, `yarn add/dlx/global add`, `bun add/install/x`, `bunx` | `package.json` |
| PyPI | `pip install`, `python -m pip install`, `uv add`, `uv pip install`, `uv tool install/run`, `uv run --with`, `uvx`, `poetry add`, `pdm add`, `pipenv install`, `pipx install/run` | `requirements*.txt`, `requirements*.in`, `pyproject.toml` |
| crates.io | `cargo add`, `cargo install` | `Cargo.toml` |
| Go | `go get`, `go install`, `go run module@version` | `go.mod` |
| RubyGems | `gem install`, `bundle add` | `Gemfile`, `gems.rb` |

Manifest edits are the agent's Write / Edit / MultiEdit calls; only dependencies the edit **adds** are checked.

The shell parser handles `sudo`, `env` and `VAR=x` prefixes, `bash -c "…"`, `eval`, `xargs`, chained commands,
redirects, comments and heredocs, and npm aliases (`alias@npm:real`).

## What it skips

These are never looked up, so private packages are not mistaken for hallucinated ones:

- an install pointed at a **private** registry: `--registry`, `-i` / `--index-url`, `--source`, `GOPROXY`, and the
  matching environment variables. Pointing at the **public** registry or a known public mirror is still checked.
- private registries configured in `.npmrc` (global or per scope) or `pip.conf`
- Go modules matched by `GOPRIVATE` / `GONOPROXY`
- local paths, archives, URLs and git sources (`./pkg`, `file:`, `git+https://…`, `--path`, `--git`)
- an `npx` / `bunx` binary that already exists in `node_modules/.bin`
- anything on your allow lists (below)

## Configuration

Set params in `~/.failproofai/policies-config.json` (all projects) or `<project>/.failproofai/policies-config.json`.
The two policies are configured separately, so repeat an allow list for both if you want it everywhere.

```json
{
  "policyParams": {
    "pack/thevirtualbuddy/slopsquat-guard/slopsquat-install-guard": {
      "allow": ["npm:internal-tool"],
      "allowPrefixes": ["@acme/", "github.com/acme/"],
      "minAgeDays": 30
    },
    "pack/thevirtualbuddy/slopsquat-guard/slopsquat-manifest-guard": {
      "allowPrefixes": ["@acme/", "github.com/acme/"]
    }
  }
}
```

Run `failproofai policies` afterwards. It warns about an entry that names no installed policy, but it does not
check the keys inside one, so check their spelling against this table.

| Param | Type | Default | Meaning |
|---|---|---|---|
| `minAgeDays` | number | `14` | Younger than this is suspicious |
| `minWeeklyDownloadsNpm` | number | `50` | npm traffic floor for a young or repo-less package |
| `minTotalDownloads` | number | `1000` | crates.io / RubyGems traffic floor for a young or repo-less package |
| `freshWindowDays` | number | `90` | What counts as "young" for the traffic and single-release rules |
| `allow` | string[] | `[]` | Exact names never looked up: `"eco:name"` or a bare name |
| `allowPrefixes` | string[] | `[]` | Name prefixes never looked up |
| `onLookupError` | string | `"warn"` | When a package can't be verified: `warn`, `allow` or `deny` |
| `pauseWindowMinutes` | number | `10` | How long a warned package stays cleared for a retry |

Ecosystem names for `allow` are `npm`, `pypi`, `cargo`, `go` and `gem`. PyPI names are compared normalized
(lowercase, runs of `-`, `_` and `.` become `-`).

## How it works

- **Lookups** run in parallel, at most 12 packages per call, under a 7-second deadline. Failproof gives a policy
  10 seconds and treats a timeout as *allow*, so the guard always decides first. A dropped connection is retried
  once; HTTP errors and timeouts are not.
- **Cheap paths first:** an npm package with 10,000+ weekly downloads, or a gem with 100,000+ total downloads,
  is accepted without fetching heavier metadata.
- **Cache:** verdicts are kept in `~/.failproofai/slopsquat/cache` for 24 hours (allowed), 6 hours (suspicious) or
  1 hour (missing). Pauses are kept in `~/.failproofai/slopsquat/pauses.json`, per agent session.
- **Never throws:** an internal error resolves through `onLookupError` rather than silently becoming *allow*.

## Known gaps

- **No look-alike detection.** A typosquat of a popular package that is old, has a repo and gets real traffic
  passes. The guard judges existence, age and traffic, not similarity to other names.
- **It only sees the agent's tool calls.** Installs inside a script (`./setup.sh`, a Makefile, a `package.json`
  script) or done through an MCP tool are not seen.
- **`pip install -r requirements.txt`** is not re-checked. Dependencies the agent adds to the file with Write / Edit
  are; lines appended by a shell command are not.
- **PyPI has no download counts** in its API, so PyPI packages are judged on age, releases and repo links only.
- **It needs the registries.** Offline, unverifiable packages pause once (or follow `onLookupError`).

## Development

```bash
# offline: parsing, manifest diffs, rules, pause-once, registry handling (121 tests)
node --import ./test/register-stub.mjs --test test/extract.test.mjs test/fixes.test.mjs

# live: real registry lookups across all five ecosystems
SLOPSQUAT_LIVE=1 HOME=$(mktemp -d) node --import ./test/register-stub.mjs --test test/live.test.mjs
```

`test/failproofai-stub.mjs` stands in for the `failproofai` module so the policy file runs under plain Node.

### Releasing

```bash
git commit -am "…" && git tag v0.1.2
failproofai publish slopsquat.mjs --min-cli-version 1.0.12 --dry-run   # inspect dist-pack/
failproofai publish slopsquat.mjs --min-cli-version 1.0.12
```

The pack must stay one file with no relative imports: Failproof pins the published artifact by its SHA-256.

## Demo

[`demo/README.md`](demo/README.md) walks through four live scenes in a throwaway project: a hallucinated package
blocked and the agent recovering, a brand-new package paused and approved, a fake dependency written into
`package.json` blocked, and one install the guard can't see.
