import { customPolicies, allow, deny } from "failproofai";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";

// Slopsquatting guard. Agents invent package names that sound right and do not
// exist; attackers register those names. Before a package reaches an install,
// look it up on its public registry:
//   missing                                -> deny (hard block)
//   exists but new / low-traffic / scripts -> warn: paused once
//   cannot be verified                     -> warn: paused once (onLookupError)
//   otherwise                              -> allow
//
// "Warn" is a pause, not a block. Failproof's instruct() lets a tool call RUN
// and attaches the text afterwards, so an instruct on `npm i x` arrives after
// x's postinstall has executed. Instead the first attempt is denied with the
// warning; the same package retried in the same session within
// pauseWindowMinutes goes through. The agent is told to confirm with the user
// before retrying.
//
// One file, no relative imports: it ships as a digest-pinned cloud artifact.
// The policy never throws (a thrown policy is treated as allow by Failproof).

const DEFAULTS = {
  // A package first published fewer days ago than this is suspicious.
  minAgeDays: 14,
  // Low traffic only counts against a package that is also young or repo-less.
  minWeeklyDownloadsNpm: 50,
  minTotalDownloads: 1000, // crates.io, RubyGems
  freshWindowDays: 90,
  // Above these, a package is established and the heavier metadata is skipped.
  trustedWeeklyDownloadsNpm: 10_000,
  trustedTotalDownloads: 100_000,
  requestTimeoutMs: 6000,
  deadlineMs: 7000,
  // Packages beyond this in one call are not looked up; they count as
  // unverified (and are warned about), never silently allowed.
  maxPackages: 12,
  // Exact names ("eco:name" or bare name) never looked up.
  allow: [],
  // Name prefixes never looked up: private scopes and hosts, e.g. "@acme/",
  // "github.com/acme/".
  allowPrefixes: [],
  // When a package cannot be verified (registry unreachable or slow, over
  // maxPackages, name built from a variable): "warn" (pause once), "allow"
  // or "deny".
  onLookupError: "warn",
  // How long a warned package stays cleared for a retry in the same session.
  pauseWindowMinutes: 10,
};

// Declared so Failproof shows and merges these as the policy's params (and so
// `failproofai publish` validates them). Configure under policyParams for each
// of the two policy names.
const PARAMS_SCHEMA = {
  minAgeDays: { type: "number", description: "A package first published fewer days ago than this is suspicious", default: DEFAULTS.minAgeDays },
  minWeeklyDownloadsNpm: { type: "number", description: "npm weekly downloads below this count against a young or repo-less package", default: DEFAULTS.minWeeklyDownloadsNpm },
  minTotalDownloads: { type: "number", description: "crates.io / RubyGems total downloads below this count against a young or repo-less package", default: DEFAULTS.minTotalDownloads },
  freshWindowDays: { type: "number", description: "A package younger than this is 'young' for the traffic and single-release rules", default: DEFAULTS.freshWindowDays },
  allow: { type: "string[]", description: "Exact names never looked up (\"eco:name\" or a bare name)", default: DEFAULTS.allow },
  allowPrefixes: { type: "string[]", description: "Name prefixes never looked up, e.g. \"@acme/\" or \"github.com/acme/\"", default: DEFAULTS.allowPrefixes },
  onLookupError: { type: "string", description: "When a package cannot be verified: warn (pause once), allow or deny", default: DEFAULTS.onLookupError },
  pauseWindowMinutes: { type: "number", description: "Minutes a warned package stays cleared for a retry in the same session", default: DEFAULTS.pauseWindowMinutes },
};

// Public registries and mirrors. A --registry / index flag or env var that
// names one of these still gets checked: pointing at the public registry is
// not a private package. Anything else is treated as a private registry.
const PUBLIC_HOSTS = {
  npm: ["registry.npmjs.org", "registry.yarnpkg.com", "registry.npmmirror.com", "registry.npm.taobao.org"],
  pypi: ["pypi.org", "pypi.python.org", "files.pythonhosted.org", "test.pypi.org", "pypi.tuna.tsinghua.edu.cn", "mirrors.aliyun.com"],
  go: ["proxy.golang.org", "goproxy.io", "goproxy.cn", "goproxy.dev"],
  gem: ["rubygems.org", "index.rubygems.org", "gems.ruby-china.com"],
  cargo: ["index.crates.io", "crates.io", "github.com/rust-lang/crates.io-index"],
};

function hostOf(url) {
  try {
    return new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(url) ? url : `https://${url}`).host.toLowerCase();
  } catch {
    return null;
  }
}

// True when `url` points at a public registry for `eco`.
export function isPublicRegistry(eco, url) {
  if (typeof url !== "string" || !url.trim()) return false;
  const u = url.trim().replace(/^sparse\+/, "");
  if (eco === "cargo" && /github\.com\/rust-lang\/crates\.io-index/.test(u)) return true;
  const host = hostOf(u);
  return Boolean(host && PUBLIC_HOSTS[eco]?.includes(host.replace(/^www\./, "")));
}

// GOPROXY is a comma/pipe list. Only public proxies plus "direct" / "off"
// keep the check on: a module fetched directly is still on the public proxy,
// and a private one belongs in GOPRIVATE (Go needs that to skip the checksum
// database anyway).
export function isPublicGoproxy(value) {
  return String(value)
    .split(/[,|]/)
    .map((s) => s.trim())
    .filter(Boolean)
    .every((s) => s === "direct" || s === "off" || isPublicRegistry("go", s));
}

const USER_AGENT = "failproofai-slopsquat-guard (+https://befailproof.ai)";
const DAY_MS = 86_400_000;

const REGISTRY_LABEL = {
  npm: "npm",
  pypi: "PyPI",
  cargo: "crates.io",
  go: "the Go module proxy",
  gem: "RubyGems",
};

function config(ctx) {
  return { ...DEFAULTS, ...(ctx?.params ?? {}) };
}

// ---------------------------------------------------------------------------
// Shell parsing
// ---------------------------------------------------------------------------

// Cheap gate so ordinary commands never get tokenized.
const MANAGER_HINT_RE =
  /\b(?:npm|npx|pnpm|pnpx|yarn|bunx?|pip[\d.]*|python[\d.]*|py|uvx?|poetry|pdm|pipx|pipenv|cargo|go|gem|bundle)\b/;

// Heredoc bodies are file contents, not commands: a README written with
// `cat <<EOF` that mentions `pip install x` must not be checked.
function stripHeredocs(cmd) {
  const lines = cmd.split("\n");
  const out = [];
  let terminator = null;
  let stripTabs = false;
  for (const line of lines) {
    if (terminator !== null) {
      const probe = stripTabs ? line.replace(/^\t+/, "") : line;
      if (probe === terminator) terminator = null;
      continue;
    }
    out.push(line);
    const m = line.match(/<<(-?)\s*(['"]?)([A-Za-z_][\w.-]*)\2/);
    if (m && !/<<</.test(line)) {
      stripTabs = m[1] === "-";
      terminator = m[3];
    }
  }
  return out.join("\n");
}

// Split into command segments of tokens. Quotes are honoured; operators,
// newlines, parens and backticks end a segment. A token that kept an
// unexpanded `$` is marked so it is never treated as a package name.
export function tokenize(cmd) {
  const segments = [];
  let seg = [];
  let tok = "";
  let inTok = false;
  let dynamic = false;
  // The word after `>`/`<` is a redirect target, never an argument.
  let dropNext = false;
  const pushTok = () => {
    if (inTok) {
      if (dropNext) dropNext = false;
      else seg.push(dynamic ? { dynamic: true, value: tok } : tok);
    }
    tok = "";
    inTok = false;
    dynamic = false;
  };
  const endSeg = () => {
    pushTok();
    if (seg.length) segments.push(seg);
    seg = [];
  };
  for (let i = 0; i < cmd.length; i++) {
    const c = cmd[i];
    if (c === "'") {
      const end = cmd.indexOf("'", i + 1);
      const stop = end === -1 ? cmd.length : end;
      tok += cmd.slice(i + 1, stop);
      inTok = true;
      i = stop;
    } else if (c === '"') {
      inTok = true;
      let j = i + 1;
      for (; j < cmd.length && cmd[j] !== '"'; j++) {
        if (cmd[j] === "\\" && j + 1 < cmd.length) {
          tok += cmd[++j];
        } else {
          if (cmd[j] === "$" || cmd[j] === "`") dynamic = true;
          tok += cmd[j];
        }
      }
      i = j;
    } else if (c === "\\") {
      if (cmd[i + 1] === "\n") i++;
      else if (i + 1 < cmd.length) {
        tok += cmd[++i];
        inTok = true;
      }
    } else if (c === " " || c === "\t") {
      pushTok();
    } else if (c === ">" || c === "<") {
      // `2>` / `2>&1`: the fd number belongs to the operator.
      if (/^\d+$/.test(tok) && !dynamic) {
        tok = "";
        inTok = false;
      } else pushTok();
      while (cmd[i + 1] === ">" || cmd[i + 1] === "<" || cmd[i + 1] === "|") i++;
      if (cmd[i + 1] === "&") {
        i++;
        while (/\d|-/.test(cmd[i + 1] ?? "")) i++;
      } else dropNext = true;
    } else if (c === "\n" || c === ";" || c === "|" || c === "&" || c === "(" || c === ")" || c === "`") {
      endSeg();
    } else if (c === "#" && !inTok) {
      // Comment to end of line.
      const nl = cmd.indexOf("\n", i);
      i = nl === -1 ? cmd.length : nl - 1;
    } else {
      if (c === "$" || c === "*" || c === "?") dynamic = true;
      tok += c;
      inTok = true;
    }
  }
  endSeg();
  return segments;
}

const str = (t) => (typeof t === "string" ? t : null);

const ENV_ASSIGN_RE = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/s;

// Drop `sudo`, `env`, `time`, `VAR=x` and friends; return the real argv and
// the inline env assignments, which can redirect a registry.
function stripPrefixes(tokens) {
  const env = {};
  let i = 0;
  while (i < tokens.length) {
    // `VAR="$X" npm i …`: an assignment with a dynamic value is still a prefix.
    const t = str(tokens[i]) ?? (ENV_ASSIGN_RE.test(tokens[i].value) ? tokens[i].value : null);
    if (t === null) return { argv: tokens.slice(i), env };
    const assign = t.match(ENV_ASSIGN_RE);
    if (assign) {
      env[assign[1]] = assign[2];
      i++;
    } else if (t === "sudo" || t === "doas") {
      i++;
      while (i < tokens.length && str(tokens[i])?.startsWith("-")) {
        const flag = str(tokens[i]);
        i++;
        if (/^-[ugCDhpRrT]$/.test(flag)) i++; // flags that take a value
      }
    } else if (t === "env") {
      i++;
      while (i < tokens.length && str(tokens[i])?.startsWith("-")) {
        const flag = str(tokens[i]);
        i++;
        if (flag === "-u" || flag === "-C" || flag === "-S") i++;
      }
    } else if (t === "time" || t === "nohup" || t === "command" || t === "exec" || t === "nice") {
      i++;
    } else {
      break;
    }
  }
  return { argv: tokens.slice(i), env };
}

// Walk args: collect positionals, collect values of the flags the caller cares
// about, and step over the values of every other value-taking flag.
// `stopAtFirst` ends the walk at the first positional (npx-style: the rest are
// arguments to the binary, not packages).
function walkArgs(args, { valueFlags = [], capture = [], stopAtFirst = false }) {
  const valued = new Set([...valueFlags, ...capture]);
  const captured = {};
  const positionals = [];
  for (let i = 0; i < args.length; i++) {
    const raw = args[i];
    const t = str(raw);
    if (t === null) {
      positionals.push(raw);
      if (stopAtFirst) break;
      continue;
    }
    if (t === "--") {
      positionals.push(...(stopAtFirst ? args.slice(i + 1, i + 2) : args.slice(i + 1)));
      break;
    }
    if (t.startsWith("-") && t.length > 1) {
      const eq = t.indexOf("=");
      const flag = eq === -1 ? t : t.slice(0, eq);
      let value;
      if (eq !== -1) value = t.slice(eq + 1);
      else if (valued.has(flag)) value = args[++i];
      if (capture.includes(flag) && value !== undefined) (captured[flag] ??= []).push(value);
      continue;
    }
    positionals.push(raw);
    if (stopAtFirst) break;
  }
  return { positionals, captured };
}

// ---- npm family -----------------------------------------------------------

const NPM_INSTALL_SUBS = new Set([
  "install", "i", "in", "ins", "inst", "insta", "instal",
  "isnt", "isnta", "isntal", "isntall", "add",
]);
const NPM_VALUE_FLAGS = [
  "--prefix", "-C", "--dir", "--cwd", "--filter", "-F", "--workspace", "-w",
  "--tag", "--cache", "--userconfig", "--save-prefix", "--omit", "--include",
  "--network-timeout", "--modules-folder", "--backend", "--cafile", "--loglevel",
];
const NPM_REGISTRY_FLAGS = ["--registry"];

// `name`, `name@range`, `@scope/name@range`, `alias@npm:real@range`.
// Returns the registry name, or null for paths, URLs, git and tarballs.
export function npmSpecName(spec) {
  if (typeof spec !== "string" || !spec) return null;
  if (/^[./~]/.test(spec) || /^(?:file|link|workspace|portal|patch|git|git\+\w+|https?|github|gitlab|bitbucket|gist):/.test(spec)) return null;
  if (spec.includes("://") || /\.(?:tgz|tar|tar\.gz)$/.test(spec)) return null;
  const alias = spec.match(/^(?:@[^/@]+\/)?[^@/]+@npm:(.+)$/);
  if (alias) return npmSpecName(alias[1]);
  let name;
  if (spec.startsWith("@")) {
    const m = spec.match(/^(@[^/@\s]+\/[^@\s]+)(?:@.*)?$/);
    if (!m) return null;
    name = m[1];
  } else {
    if (spec.includes("/")) return null; // github shorthand user/repo
    name = spec.split("@")[0];
  }
  return /^(?:@[a-z0-9-~][a-z0-9-._~]*\/)?[a-z0-9-~][a-z0-9-._~]*$/i.test(name) ? name.toLowerCase() : null;
}

// A spec token that is a variable or command substitution: the real name is
// only known at run time, so it cannot be checked. Kept as `dynamic` so the
// policy can warn instead of silently skipping it.
function specOf(s, toName, eco) {
  if (str(s) !== null) return { name: toName(s) };
  const v = String(s.value);
  const cut = v.search(/[$`*?]/);
  const prefix = cut === -1 ? v : v.slice(0, cut);
  // A path, archive or URL with a glob or variable in it is not a registry name.
  if (/^[./~]/.test(prefix) || prefix.includes("://") || /^(?:git\+|file:|link:)/.test(prefix)) return { name: null };
  if (/\.(?:whl|zip|tgz|tar|tar\.gz|tar\.bz2|gem|crate)$/i.test(v)) return { name: null };
  // Outside Go, a registry name has no "/" (npm scopes aside), so `dist/*.whl`
  // or `vendor/$X` is a local path.
  if (eco !== "go" && !prefix.startsWith("@") && prefix.includes("/")) return { name: null };
  // `lodash@$VERSION`, `requests==$V`: the name is static, only the version varies.
  if (/[@=<>~!]/.test(prefix.replace(/^@/, ""))) {
    const n = toName(prefix);
    if (n) return { name: n };
  }
  return { name: null, dynamic: v };
}

// A registry setting only switches the check off when it names a private
// registry. Values that are themselves dynamic count as private (unknowable).
const privateRegistry = (eco, values) =>
  (values ?? []).some((v) => (typeof v === "string" ? !isPublicRegistry(eco, v) : true));

function npmFamily(cmd, args, env) {
  if (privateRegistry("npm", [env.npm_config_registry, env.NPM_CONFIG_REGISTRY].filter((v) => v !== undefined))) return [];
  const flags = { valueFlags: NPM_VALUE_FLAGS, capture: [...NPM_REGISTRY_FLAGS, "--package", "-p"] };
  const head = walkArgs(args, { ...flags, stopAtFirst: true });
  if (privateRegistry("npm", head.captured["--registry"])) return [];

  // One-shot runners fetch the first positional (or every --package).
  const runner = (rest) => {
    const r = walkArgs(rest, { ...flags, valueFlags: [...NPM_VALUE_FLAGS, "-c", "--call"], stopAtFirst: true });
    if (privateRegistry("npm", r.captured["--registry"])) return [];
    const pkgs = [...(r.captured["--package"] ?? []), ...(r.captured["-p"] ?? [])];
    const specs = pkgs.length ? pkgs : r.positionals.slice(0, 1);
    return specs.map((s) => ({ ...specOf(s, (t) => npmSpecName(str(t)), "npm"), runner: !pkgs.length }));
  };
  const installer = (rest) => {
    const r = walkArgs(rest, flags);
    if (privateRegistry("npm", r.captured["--registry"])) return [];
    return r.positionals.map((s) => specOf(s, (t) => npmSpecName(str(t)), "npm"));
  };

  if (cmd === "npx" || cmd === "pnpx" || cmd === "bunx") return runner(args);

  const sub = str(head.positionals[0]);
  const rest = args.slice(args.indexOf(head.positionals[0]) + 1);
  if (cmd === "npm") {
    if (NPM_INSTALL_SUBS.has(sub)) return installer(rest);
    if (sub === "exec" || sub === "x") return runner(rest);
    return [];
  }
  if (cmd === "yarn") {
    if (sub === "add") return installer(rest);
    if (sub === "dlx") return runner(rest);
    if (sub === "global") {
      const g = walkArgs(rest, { ...flags, stopAtFirst: true });
      if (str(g.positionals[0]) === "add") return installer(rest.slice(rest.indexOf(g.positionals[0]) + 1));
    }
    return [];
  }
  if (cmd === "pnpm") {
    if (sub === "add" || sub === "install" || sub === "i") return installer(rest);
    if (sub === "dlx") return runner(rest);
    return [];
  }
  if (cmd === "bun") {
    if (sub === "add" || sub === "a" || sub === "install" || sub === "i") return installer(rest);
    if (sub === "x") return runner(rest);
    return [];
  }
  return [];
}

// ---- PyPI family ----------------------------------------------------------

const PY_VALUE_FLAGS = [
  "-r", "--requirement", "-c", "--constraint", "-e", "--editable", "-t", "--target",
  "--prefix", "--root", "--src", "-f", "--find-links", "--extra-index-url",
  "--python", "-p", "--group", "--extra", "-G", "--platform", "--python-version",
  "--implementation", "--abi", "--only-binary", "--no-binary", "--progress-bar",
  "--log", "--cache-dir", "--upgrade-strategy", "--trusted-host", "--proxy",
  "--timeout", "--retries", "--exists-action", "--optional", "--directory",
  "--project", "--package", "--dev-group", "--config-file", "--suffix", "--pip-args",
  "--python-preference", "--resolution", "--prerelease", "-C", "--config-settings",
];
const PY_REGISTRY_FLAGS = ["-i", "--index-url", "--index", "--default-index", "--source"];

// PEP 508: the distribution name leads; extras, specifiers, direct
// references and markers follow. Returns the PEP 503 normalized name.
export function pySpecName(spec) {
  if (typeof spec !== "string" || !spec) return null;
  if (/^[./~]/.test(spec) || spec.includes("://") || /\.(?:whl|zip|tar\.gz|tgz|tar\.bz2)$/i.test(spec)) return null;
  if (/^(?:git|hg|svn|bzr)\+/.test(spec)) return null;
  const m = spec.match(/^\s*([A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?)\s*(.*)$/s);
  if (!m) return null;
  const rest = m[2];
  if (/^(?:\[[^\]]*\])?\s*@/.test(rest)) return null; // name @ url
  if (rest && !/^[\[=<>!~;,\s@(]/.test(rest)) return null; // not a requirement
  return m[1].toLowerCase().replace(/[-_.]+/g, "-");
}

const PY_INDEX_ENV = ["PIP_INDEX_URL", "UV_INDEX_URL", "UV_DEFAULT_INDEX", "UV_INDEX", "PIP_INDEX"];

function pyArgs(rest, { runner = false } = {}) {
  const r = walkArgs(rest, {
    valueFlags: PY_VALUE_FLAGS,
    capture: [...PY_REGISTRY_FLAGS, "--with", "--from", "--spec"],
    stopAtFirst: runner,
  });
  if (PY_REGISTRY_FLAGS.some((f) => privateRegistry("pypi", r.captured[f]))) return [];
  const extra = [...(r.captured["--with"] ?? []).flatMap((v) => String(v).split(",")), ...(r.captured["--from"] ?? []), ...(r.captured["--spec"] ?? [])];
  // `uvx --from pkg bin` and `pipx run --spec pkg bin`: the positional is a binary.
  const fromGiven = r.captured["--from"] || r.captured["--spec"];
  const pos = runner && fromGiven ? [] : r.positionals;
  return [...pos, ...extra].map((s) => specOf(s, (t) => pySpecName(str(t)), "pypi"));
}

function pypiFamily(cmd, args, env) {
  if (privateRegistry("pypi", PY_INDEX_ENV.map((k) => env[k]).filter((v) => v !== undefined))) return [];
  const sub = str(args[0]);
  const rest = args.slice(1);
  if (/^pip[\d.]*$/.test(cmd)) return sub === "install" ? pyArgs(rest) : [];
  if (/^python[\d.]*$/.test(cmd) || cmd === "py") {
    const m = args.findIndex((a) => str(a) === "-m");
    if (m === -1 || !/^pip[\d.]*$/.test(str(args[m + 1]) ?? "")) return [];
    return str(args[m + 2]) === "install" ? pyArgs(args.slice(m + 3)) : [];
  }
  if (cmd === "uvx") return pyArgs(args, { runner: true });
  if (cmd === "uv") {
    if (sub === "add") return pyArgs(rest);
    if (sub === "pip" && str(rest[0]) === "install") return pyArgs(rest.slice(1));
    if (sub === "tool" && str(rest[0]) === "install") return pyArgs(rest.slice(1));
    if (sub === "tool" && str(rest[0]) === "run") return pyArgs(rest.slice(1), { runner: true });
    if (sub === "run") {
      // Only `--with` fetches packages here; the positional is a script or binary.
      const r = walkArgs(rest, { valueFlags: PY_VALUE_FLAGS, capture: [...PY_REGISTRY_FLAGS, "--with"], stopAtFirst: true });
      if (PY_REGISTRY_FLAGS.some((f) => privateRegistry("pypi", r.captured[f]))) return [];
      return (r.captured["--with"] ?? []).flatMap((v) => String(v).split(",")).map((s) => ({ name: pySpecName(s) }));
    }
    return [];
  }
  if (cmd === "poetry" || cmd === "pdm") {
    if (sub !== "add") return [];
    // poetry accepts `name@^1.2` and `name@latest`.
    return pyArgs(rest.map((a) => (typeof a === "string" && !a.includes("://") ? a.split("@")[0] : a)));
  }
  if (cmd === "pipenv") return sub === "install" ? pyArgs(rest) : [];
  if (cmd === "pipx") {
    if (sub === "install") return pyArgs(rest);
    if (sub === "run") return pyArgs(rest, { runner: true });
    return [];
  }
  return [];
}

// ---- Cargo ----------------------------------------------------------------

const CARGO_VALUE_FLAGS = [
  "--features", "-F", "--rename", "--package", "-p", "--branch", "--tag", "--rev",
  "--version", "--vers", "--target", "--root", "--manifest-path", "--profile", "--jobs",
  "-j", "--bin", "--example", "--target-dir", "--config", "-Z", "--color",
];
const CARGO_SOURCE_FLAGS = ["--git", "--path", "--registry", "--index"];

export function cargoSpecName(spec) {
  if (typeof spec !== "string") return null;
  const name = spec.split("@")[0];
  return /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(name) ? name.toLowerCase() : null;
}

function cargoFamily(args) {
  const sub = str(args[0]);
  if (sub !== "add" && sub !== "install") return [];
  const r = walkArgs(args.slice(1), { valueFlags: CARGO_VALUE_FLAGS, capture: CARGO_SOURCE_FLAGS });
  // --git / --path are not registry installs at all.
  if (r.captured["--git"] || r.captured["--path"]) return [];
  // --registry names a configured registry; only "crates-io" is the public one.
  if ((r.captured["--registry"] ?? []).some((v) => v !== "crates-io")) return [];
  if (privateRegistry("cargo", r.captured["--index"])) return [];
  return r.positionals.map((s) => specOf(s, (t) => cargoSpecName(str(t)), "cargo"));
}

// ---- Go -------------------------------------------------------------------

export function goSpecName(spec) {
  if (typeof spec !== "string" || !spec) return null;
  const path = spec.split("@")[0];
  if (/^[./]/.test(path) || path === "all" || path.includes("...")) return null;
  const first = path.split("/")[0];
  if (!first.includes(".")) return null; // standard library or a local module
  return /^[A-Za-z0-9.~_+-]+(?:\/[A-Za-z0-9.~_+-]+)*$/.test(path) ? path : null;
}

function goFamily(args) {
  const sub = str(args[0]);
  const r = walkArgs(args.slice(1), { valueFlags: ["-C", "-o", "-mod", "-modfile", "-tags", "-ldflags", "-gcflags", "-p", "-exec", "-overlay", "-pgo"] });
  if (sub === "get" || sub === "install") return r.positionals.map((s) => specOf(s, (t) => goSpecName(str(t)), "go"));
  // `go run mod@version` downloads; a plain `go run` builds local code.
  if (sub === "run") {
    const first = str(r.positionals[0]);
    return first?.includes("@") ? [{ name: goSpecName(first) }] : [];
  }
  return [];
}

// ---- RubyGems -------------------------------------------------------------

const GEM_VALUE_FLAGS = [
  "-v", "--version", "-i", "--install-dir", "-n", "--bindir", "--platform",
  "--group", "-g", "--branch", "--ref", "--require", "-r", "--document",
  "--build-root", "--file",
];
const GEM_SOURCE_FLAGS = ["-s", "--source", "--git", "--github", "--path", "--clear-sources"];

export function gemSpecName(spec) {
  if (typeof spec !== "string") return null;
  if (/\.gem$/.test(spec) || /^[./~]/.test(spec)) return null;
  const name = spec.split(":")[0];
  return /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name) ? name : null;
}

function gemFamily(cmd, args) {
  const sub = str(args[0]);
  if (!((cmd === "gem" && sub === "install") || (cmd === "bundle" && sub === "add"))) return [];
  const r = walkArgs(args.slice(1), { valueFlags: GEM_VALUE_FLAGS, capture: GEM_SOURCE_FLAGS });
  // --git / --github / --path are not registry installs; --source and
  // --clear-sources only switch the check off for a private source.
  if (["--git", "--github", "--path"].some((f) => r.captured[f])) return [];
  if (["-s", "--source"].some((f) => privateRegistry("gem", r.captured[f]))) return [];
  if (r.captured["--clear-sources"] && !(r.captured["-s"] || r.captured["--source"])) return [];
  if (cmd === "gem" && args.includes("-g")) return [];
  return r.positionals.map((s) => specOf(s, (t) => gemSpecName(str(t)), "gem"));
}

// ---- Dispatch -------------------------------------------------------------

function extractSegment(tokens, depth) {
  const { argv, env } = stripPrefixes(tokens);
  const cmd0 = str(argv[0]);
  if (!cmd0) return [];
  const cmd = basename(cmd0);
  const args = argv.slice(1);

  // `bash -c "npm install x"`: parse the inner command once.
  if (/^(?:ba|z|da|k)?sh$/.test(cmd) && depth === 0) {
    const c = args.findIndex((a) => str(a) === "-c" || /^-[a-z]*c$/.test(str(a) ?? ""));
    if (c !== -1 && str(args[c + 1])) return collect(str(args[c + 1]), depth + 1);
    return [];
  }
  // `eval 'npm i x'`: the arguments are joined and run as a command.
  // A quoted argument that contains `$` is re-parsed from its raw text, so
  // `eval "npm i $PKG"` still surfaces `$PKG` as an unverifiable name, while
  // `eval "$(npm completion)"` stays harmless.
  if (cmd === "eval" && depth <= 1) {
    return collect(args.map((a) => str(a) ?? a.value).join(" "), depth + 1);
  }
  // `… | xargs npm i`: the package names arrive on stdin, so they cannot be
  // read here. A stand-in dynamic token makes an installer report them as
  // unverifiable instead of looking like a bare `npm install`.
  if (cmd === "xargs" && depth <= 1) {
    let i = 0;
    while (i < args.length && str(args[i])?.startsWith("-")) {
      const f = str(args[i]);
      i++;
      if (/^-[nLIdPsEa]$/.test(f) || /^--(?:max-args|max-lines|replace|delimiter|max-procs|max-chars|eof|arg-file)$/.test(f)) i++;
    }
    const inner = args.slice(i);
    if (!inner.length) return [];
    return extractSegment([...inner, { dynamic: true, value: "names from stdin via xargs" }], depth + 1);
  }

  const tag = (eco, list) => list.map((p) => ({ ...p, eco }));
  if (["npm", "npx", "pnpm", "pnpx", "yarn", "bun", "bunx"].includes(cmd)) return tag("npm", npmFamily(cmd, args, env));
  if (/^(?:pip[\d.]*|python[\d.]*|py|uvx?|poetry|pdm|pipenv|pipx)$/.test(cmd)) return tag("pypi", pypiFamily(cmd, args, env));
  if (cmd === "cargo") return tag("cargo", cargoFamily(args));
  if (cmd === "go") {
    if (env.GOPROXY !== undefined && !isPublicGoproxy(env.GOPROXY)) return [];
    const goEnv = { GOPRIVATE: env.GOPRIVATE, GONOPROXY: env.GONOPROXY };
    return tag("go", goFamily(args)).map((p) => ({ ...p, goEnv }));
  }
  if (cmd === "gem" || cmd === "bundle") return tag("gem", gemFamily(cmd, args));
  return [];
}

// Every spec a shell command would fetch, named or not.
function collect(cmd, depth = 0) {
  if (typeof cmd !== "string" || !MANAGER_HINT_RE.test(cmd)) return [];
  const out = [];
  for (const seg of tokenize(stripHeredocs(cmd))) out.push(...extractSegment(seg, depth));
  return out;
}

// Every registry package a shell command would fetch, as `{ eco, name }`.
// Specs that resolve to no registry name (paths, URLs, `$VAR`s) are dropped.
export function extractFromCommand(cmd) {
  return dedupe(collect(cmd).filter((p) => p.name));
}

// The packages a command fetches, plus the specs that cannot be checked
// because their names are only known at run time ($VAR, $(…), xargs stdin).
export function inspectCommand(cmd) {
  const all = collect(cmd);
  return {
    packages: dedupe(all.filter((p) => p.name)),
    dynamic: all.filter((p) => !p.name && p.dynamic).map((p) => ({ eco: p.eco, spec: String(p.dynamic) })),
  };
}

function dedupe(list) {
  const seen = new Set();
  return list.filter((p) => {
    const k = `${p.eco}:${p.name}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

// ---------------------------------------------------------------------------
// Manifest parsing
// ---------------------------------------------------------------------------

export function manifestKind(filePath) {
  const base = basename(String(filePath ?? ""));
  if (base === "package.json") return "npm";
  if (/requirements.*\.(?:txt|in)$/i.test(base) || (/\.(?:txt|in)$/.test(base) && basename(dirname(String(filePath))) === "requirements")) return "requirements";
  if (base === "pyproject.toml") return "pyproject";
  if (base === "Cargo.toml") return "cargo";
  if (base === "go.mod") return "go";
  if (base === "Gemfile" || base === "gems.rb") return "gem";
  return null;
}

const MANIFEST_ECO = { npm: "npm", requirements: "pypi", pyproject: "pypi", cargo: "cargo", go: "go", gem: "gem" };

function npmManifestNames(text) {
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    return null;
  }
  const names = new Set();
  for (const key of ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"]) {
    const deps = json?.[key];
    if (!deps || typeof deps !== "object") continue;
    for (const [name, range] of Object.entries(deps)) {
      const r = String(range);
      if (/^(?:npm:)/.test(r)) {
        const real = npmSpecName(r.slice(4));
        if (real) names.add(real);
        continue;
      }
      if (/^(?:file|link|workspace|portal|patch|git|git\+\w+|https?|github|gitlab|bitbucket):/.test(r) || r.includes("/")) continue;
      const n = npmSpecName(name);
      if (n) names.add(n);
    }
  }
  return names;
}

function requirementsNames(text) {
  const names = new Set();
  for (let line of text.split("\n")) {
    line = line.replace(/(?:^|\s)#.*$/, "").trim();
    if (!line || line.startsWith("-")) continue;
    const n = pySpecName(line);
    if (n) names.add(n);
  }
  return names;
}

// Splits TOML into `[table]` sections with their raw bodies. Good enough for
// dependency tables; not a TOML parser.
function tomlSections(text) {
  const sections = [];
  let current = { header: "", lines: [] };
  for (const line of text.split("\n")) {
    const h = line.match(/^\s*\[\[?\s*([^\]]+?)\s*\]\]?\s*(?:#.*)?$/);
    if (h) {
      sections.push(current);
      current = { header: h[1].replace(/\s+/g, ""), lines: [] };
    } else {
      current.lines.push(line);
    }
  }
  sections.push(current);
  return sections;
}

function tomlStrings(text) {
  return [...text.matchAll(/"((?:[^"\\]|\\.)*)"|'([^']*)'/g)].map((m) => m[1] ?? m[2]);
}

// `key = [ ... ]` arrays (possibly multiline) inside one section body.
function tomlArrays(lines) {
  const body = lines.map((l) => l.replace(/(^|[^"'])#.*$/, "$1")).join("\n");
  const out = {};
  for (const m of body.matchAll(/^\s*([A-Za-z0-9_.-]+|"[^"]+")\s*=\s*\[([\s\S]*?)\]/gm)) {
    out[m[1].replace(/"/g, "")] = tomlStrings(m[2]);
  }
  return out;
}

function tomlKeys(lines) {
  const out = [];
  for (const line of lines) {
    const m = line.match(/^\s*([A-Za-z0-9_.-]+|"[^"]+")\s*=\s*(.*)$/);
    if (m) out.push({ key: m[1].replace(/"/g, ""), value: m[2] });
  }
  return out;
}

function pyprojectNames(text) {
  const names = new Set();
  const add = (spec) => {
    const n = pySpecName(spec);
    if (n) names.add(n);
  };
  for (const { header, lines } of tomlSections(text)) {
    if (header === "project") {
      for (const spec of tomlArrays(lines).dependencies ?? []) add(spec);
    } else if (header === "project.optional-dependencies" || header === "dependency-groups") {
      for (const specs of Object.values(tomlArrays(lines))) specs.forEach(add);
    } else if (/^tool\.poetry\.(?:(?:group\.[^.]+\.)?dependencies|dev-dependencies)$/.test(header)) {
      for (const { key, value } of tomlKeys(lines)) {
        if (key === "python" || /\b(?:path|git|url)\s*=/.test(value)) continue;
        add(key);
      }
    }
  }
  return names;
}

function cargoNames(text) {
  const names = new Set();
  const DEP_TABLE = /^(?:target\..+\.)?(?:dev-|build-)?dependencies$/;
  for (const { header, lines } of tomlSections(text)) {
    if (DEP_TABLE.test(header)) {
      for (const { key, value } of tomlKeys(lines)) {
        if (/\b(?:path|git|registry|workspace)\s*=/.test(value)) continue;
        const pkg = value.match(/\bpackage\s*=\s*"([^"]+)"/);
        const n = cargoSpecName(pkg ? pkg[1] : key);
        if (n) names.add(n);
      }
    }
    const sub = header.match(/^(?:target\..+\.)?(?:dev-|build-)?dependencies\.([A-Za-z0-9_-]+)$/);
    if (sub) {
      const body = lines.join("\n");
      if (/^\s*(?:path|git|registry|workspace)\s*=/m.test(body)) continue;
      const pkg = body.match(/^\s*package\s*=\s*"([^"]+)"/m);
      const n = cargoSpecName(pkg ? pkg[1] : sub[1]);
      if (n) names.add(n);
    }
  }
  return names;
}

function goModNames(text) {
  const names = new Set();
  const replaced = new Set();
  for (const m of text.matchAll(/^\s*(?:replace\s+)?(\S+)(?:\s+\S+)?\s+=>\s+(\S+)/gm)) {
    if (/^[./]/.test(m[2])) replaced.add(m[1]);
  }
  let inBlock = false;
  for (const raw of text.split("\n")) {
    const line = raw.replace(/\/\/.*$/, "").trim();
    if (/^require\s*\($/.test(line)) {
      inBlock = true;
      continue;
    }
    if (inBlock && line === ")") {
      inBlock = false;
      continue;
    }
    const m = inBlock ? line.match(/^(\S+)\s+v\S+/) : line.match(/^require\s+(\S+)\s+v\S+/);
    if (m && !replaced.has(m[1])) {
      const n = goSpecName(m[1]);
      if (n) names.add(n);
    }
  }
  return names;
}

function gemfileNames(text) {
  const names = new Set();
  let privateSourceDepth = 0;
  for (const raw of text.split("\n")) {
    const line = raw.replace(/#.*$/, "").trim();
    const src = line.match(/^source\s+["']([^"']+)["']\s+do\b/);
    if (src) {
      if (!/rubygems\.org/.test(src[1]) || privateSourceDepth) privateSourceDepth++;
      continue;
    }
    if (privateSourceDepth && /^(?:\w+\s+.*\bdo\b|\w+\s+do\b)/.test(line)) privateSourceDepth++;
    if (privateSourceDepth && line === "end") {
      privateSourceDepth--;
      continue;
    }
    if (privateSourceDepth) continue;
    const m = line.match(/^gem\s+["']([^"']+)["'](.*)$/);
    if (!m || /\b(?:path|git|github|source)\s*(?::|=>)/.test(m[2])) continue;
    const n = gemSpecName(m[1]);
    if (n) names.add(n);
  }
  return names;
}

const MANIFEST_PARSERS = {
  npm: npmManifestNames,
  requirements: requirementsNames,
  pyproject: pyprojectNames,
  cargo: cargoNames,
  go: goModNames,
  gem: gemfileNames,
};

// Dependency names present in `after` and not in `before`.
export function addedDependencies(kind, before, after) {
  const parse = MANIFEST_PARSERS[kind];
  if (!parse) return [];
  const next = parse(after ?? "");
  if (!next) return []; // unparseable mid-edit; nothing to judge
  const prev = parse(before ?? "") ?? new Set();
  return [...next].filter((n) => !prev.has(n)).map((name) => ({ eco: MANIFEST_ECO[kind], name }));
}

function readFileOr(path, fallback) {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return fallback;
  }
}

function applyEdit(text, oldString, newString, replaceAll) {
  if (typeof oldString !== "string" || typeof newString !== "string") return text;
  if (oldString === "") return text + newString;
  return replaceAll ? text.split(oldString).join(newString) : text.replace(oldString, () => newString);
}

// The dependencies a Write / Edit / MultiEdit adds to a manifest.
export function extractFromManifestEdit(toolName, toolInput, cwd) {
  const filePath = toolInput?.file_path;
  const kind = manifestKind(filePath);
  if (!kind) return [];
  const abs = isAbsolute(filePath) ? filePath : resolve(cwd ?? process.cwd(), filePath);
  const before = readFileOr(abs, "");
  let after;
  if (toolName === "Write") after = String(toolInput.content ?? "");
  else if (toolName === "Edit") after = applyEdit(before, toolInput.old_string, toolInput.new_string, toolInput.replace_all);
  else if (toolName === "MultiEdit" && Array.isArray(toolInput.edits)) {
    after = toolInput.edits.reduce((t, e) => applyEdit(t, e?.old_string, e?.new_string, e?.replace_all), before);
  } else return [];
  return addedDependencies(kind, before, after);
}

// ---------------------------------------------------------------------------
// Local registry configuration: private registries must not read as "missing"
// ---------------------------------------------------------------------------

const localConfigCache = new Map();

function findUp(start, name) {
  let dir = start;
  for (let i = 0; i < 40; i++) {
    const p = join(dir, name);
    if (existsSync(p)) return p;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
  return null;
}

function localConfig(cwd) {
  const key = cwd ?? "";
  const hit = localConfigCache.get(key);
  if (hit && Date.now() - hit.at < 60_000) return hit.value;

  const npmrcs = [cwd && findUp(cwd, ".npmrc"), join(homedir(), ".npmrc")].filter(Boolean);
  const npmScopes = [];
  let npmPrivate = false;
  for (const file of npmrcs) {
    for (const line of readFileOr(file, "").split("\n")) {
      const scoped = line.match(/^\s*(@[^:\s]+):registry\s*=\s*(\S+)/);
      if (scoped && !isPublicRegistry("npm", scoped[2])) npmScopes.push(`${scoped[1].toLowerCase()}/`);
      const global = line.match(/^\s*registry\s*=\s*(\S+)/);
      if (global && !isPublicRegistry("npm", global[1])) npmPrivate = true;
    }
  }

  const pipConfs = [
    process.env.PIP_CONFIG_FILE,
    process.env.VIRTUAL_ENV && join(process.env.VIRTUAL_ENV, "pip.conf"),
    join(homedir(), ".config", "pip", "pip.conf"),
    join(homedir(), ".pip", "pip.conf"),
    join(homedir(), "Library", "Application Support", "pip", "pip.conf"),
    "/etc/pip.conf",
  ].filter(Boolean);
  let pypiPrivate = PY_INDEX_ENV.some((k) => process.env[k] && !isPublicRegistry("pypi", process.env[k]));
  for (const file of pipConfs) {
    const m = readFileOr(file, "").match(/^\s*index-url\s*=\s*(\S+)/m);
    if (m && !isPublicRegistry("pypi", m[1])) pypiPrivate = true;
  }

  const envRegistry = process.env.npm_config_registry ?? process.env.NPM_CONFIG_REGISTRY;
  if (envRegistry && !isPublicRegistry("npm", envRegistry)) npmPrivate = true;
  const value = { npmPrivate, npmScopes, pypiPrivate };
  localConfigCache.set(key, { at: Date.now(), value });
  return value;
}

function goPrivatePatterns(goEnv) {
  return [goEnv?.GOPRIVATE, goEnv?.GONOPROXY, process.env.GOPRIVATE, process.env.GONOPROXY]
    .filter(Boolean)
    .flatMap((v) => v.split(","))
    .map((s) => s.trim())
    .filter(Boolean);
}

// GOPRIVATE globs match path prefixes element by element.
function goPathMatches(pattern, path) {
  const pp = pattern.split("/");
  const parts = path.split("/");
  if (parts.length < pp.length) return false;
  return pp.every((seg, i) => new RegExp(`^${seg.replace(/[.+^${}()|\\]/g, "\\$&").replace(/\*/g, "[^/]*").replace(/\?/g, "[^/]")}$`).test(parts[i]));
}

// npx-style runners resolve a local bin before they fetch anything.
function hasLocalBin(cwd, name) {
  if (!cwd) return false;
  const bin = name.startsWith("@") ? name.split("/")[1] : name;
  return Boolean(findUp(cwd, join("node_modules", ".bin", bin)));
}

function isSkipped(pkg, cfg, cwd) {
  const { eco, name } = pkg;
  if (cfg.allow.includes(name) || cfg.allow.includes(`${eco}:${name}`)) return true;
  if (cfg.allowPrefixes.some((p) => name.startsWith(p))) return true;
  const local = localConfig(cwd);
  if (eco === "npm") {
    if (local.npmPrivate) return true;
    if (local.npmScopes.some((s) => name.startsWith(s))) return true;
    if (pkg.runner && hasLocalBin(cwd, name)) return true;
  }
  if (eco === "pypi" && local.pypiPrivate) return true;
  if (eco === "go" && goPrivatePatterns(pkg.goEnv).some((p) => goPathMatches(p, name))) return true;
  if (eco === "go" && process.env.GOPROXY && !isPublicGoproxy(process.env.GOPROXY)) return true;
  return false;
}

// ---------------------------------------------------------------------------
// Registry lookups
// ---------------------------------------------------------------------------

class HttpStatus extends Error {
  constructor(status) {
    super(`HTTP ${status}`);
    this.status = status;
  }
}

async function getJson(url, signal, accept = "application/json") {
  const res = await fetch(url, { signal, headers: { "user-agent": USER_AGENT, accept } });
  if (!res.ok) throw new HttpStatus(res.status);
  return res.json();
}

const isMissing = (err) => err instanceof HttpStatus && (err.status === 404 || err.status === 410);
const timeOf = (s) => {
  const t = Date.parse(s ?? "");
  return Number.isFinite(t) ? t : null;
};
const REPO_RE = /github\.com|gitlab\.com|bitbucket\.org|codeberg\.org|sr\.ht|git\./i;

async function lookupNpm(name, signal, cfg) {
  const enc = name.replace("/", "%2f");
  // Existence (a HEAD, cheap even for huge packuments) and traffic in parallel:
  // a miss costs ~2s on each endpoint.
  const [head, dl] = await Promise.allSettled([
    fetch(`https://registry.npmjs.org/${enc}`, { method: "HEAD", signal, headers: { "user-agent": USER_AGENT } }),
    getJson(`https://api.npmjs.org/downloads/point/last-week/${name}`, signal),
  ]);
  if (head.status === "rejected") throw head.reason;
  if (head.value.status === 404) return { status: "missing" };
  if (!head.value.ok) throw new HttpStatus(head.value.status);
  // The download index lags new packages by about a day; a 404 there is not a miss.
  if (dl.status === "rejected" && !isMissing(dl.reason)) throw dl.reason;
  const downloads = dl.status === "fulfilled" ? dl.value.downloads ?? null : null;
  if (downloads !== null && downloads >= cfg.trustedWeeklyDownloadsNpm) return { status: "ok", downloads };
  let doc;
  try {
    doc = await getJson(`https://registry.npmjs.org/${enc}`, signal);
  } catch (err) {
    if (isMissing(err)) return { status: "missing" };
    throw err;
  }
  if (doc.time?.unpublished || !doc.versions || !Object.keys(doc.versions).length) {
    return { status: "missing", unpublished: true };
  }
  const latest = doc.versions[doc["dist-tags"]?.latest] ?? {};
  const scripts = latest.scripts ?? {};
  return {
    status: "ok",
    downloads,
    createdAt: timeOf(doc.time?.created),
    versionCount: Object.keys(doc.versions).length,
    hasRepo: Boolean(doc.repository?.url ?? doc.repository) || REPO_RE.test(doc.homepage ?? ""),
    installScripts: ["preinstall", "install", "postinstall"].some((s) => scripts[s]),
  };
}

async function lookupPypi(name, signal) {
  let doc;
  try {
    doc = await getJson(`https://pypi.org/pypi/${name}/json`, signal);
  } catch (err) {
    if (isMissing(err)) return { status: "missing" };
    throw err;
  }
  let createdAt = null;
  let fileCount = 0;
  for (const files of Object.values(doc.releases ?? {})) {
    for (const f of files) {
      fileCount++;
      const t = timeOf(f.upload_time_iso_8601 ?? f.upload_time);
      if (t !== null && (createdAt === null || t < createdAt)) createdAt = t;
    }
  }
  const urls = [...Object.entries(doc.info?.project_urls ?? {}).flat(), doc.info?.home_page ?? ""].join(" ");
  return {
    status: "ok",
    createdAt,
    versionCount: Object.keys(doc.releases ?? {}).length,
    hasRepo: REPO_RE.test(urls) || /source|repo|code/i.test(Object.keys(doc.info?.project_urls ?? {}).join(" ")),
    noFiles: fileCount === 0,
  };
}

async function lookupCargo(name, signal) {
  let doc;
  try {
    doc = await getJson(`https://crates.io/api/v1/crates/${name}?include=default_version`, signal);
  } catch (err) {
    if (isMissing(err)) return { status: "missing" };
    throw err;
  }
  const c = doc.crate ?? {};
  return {
    status: "ok",
    createdAt: timeOf(c.created_at),
    downloads: c.downloads ?? null,
    versionCount: c.num_versions ?? null,
    hasRepo: Boolean(c.repository),
  };
}

// Module paths escape upper case as `!lower`.
const goEscape = (p) => p.replace(/[A-Z]/g, (c) => `!${c.toLowerCase()}`);

// `go install host/org/repo/cmd/tool@v1` names a package inside a module: walk
// up the path until the proxy knows a module.
function goCandidates(path) {
  const parts = path.split("/");
  const out = [];
  for (let n = parts.length; n >= 2 && out.length < 4; n--) out.push(parts.slice(0, n).join("/"));
  return out;
}

async function lookupGo(path, signal) {
  for (const mod of goCandidates(path)) {
    let latest;
    try {
      latest = await getJson(`https://proxy.golang.org/${goEscape(mod)}/@latest`, signal);
    } catch (err) {
      if (isMissing(err)) continue;
      throw err;
    }
    const res = await fetch(`https://proxy.golang.org/${goEscape(mod)}/@v/list`, { signal, headers: { "user-agent": USER_AGENT } });
    const versions = res.ok ? (await res.text()).split("\n").filter(Boolean) : [];
    let createdAt = null;
    if (versions.length <= 2) {
      // Few tags: the oldest one is the module's age.
      const times = [timeOf(latest.Time)];
      for (const v of versions) {
        try {
          times.push(timeOf((await getJson(`https://proxy.golang.org/${goEscape(mod)}/@v/${v}.info`, signal)).Time));
        } catch {}
      }
      createdAt = Math.min(...times.filter((t) => t !== null));
      if (!Number.isFinite(createdAt)) createdAt = null;
    }
    // With no tags, the only time the proxy has is the latest pseudo-version's:
    // when the newest code landed, not when the module first appeared.
    return { status: "ok", module: mod, createdAt, versionCount: versions.length, hasRepo: true, ageBasis: versions.length ? "first" : "latest" };
  }
  return { status: "missing" };
}

async function lookupGem(name, signal, cfg) {
  let doc;
  try {
    doc = await getJson(`https://rubygems.org/api/v1/gems/${name}.json`, signal);
  } catch (err) {
    if (isMissing(err)) return { status: "missing" };
    throw err;
  }
  const meta = {
    status: "ok",
    downloads: doc.downloads ?? null,
    hasRepo: REPO_RE.test(`${doc.source_code_uri ?? ""} ${doc.homepage_uri ?? ""}`),
  };
  if ((meta.downloads ?? 0) >= cfg.trustedTotalDownloads) return meta;
  const versions = await getJson(`https://rubygems.org/api/v1/versions/${name}.json`, signal);
  const times = versions.map((v) => timeOf(v.created_at)).filter((t) => t !== null);
  return { ...meta, versionCount: versions.length, createdAt: times.length ? Math.min(...times) : null };
}

const LOOKUPS = { npm: lookupNpm, pypi: lookupPypi, cargo: lookupCargo, go: lookupGo, gem: lookupGem };

// ---- Cache ----------------------------------------------------------------

// Under the user's own ~/.failproofai, not os.tmpdir(): on Linux /tmp is shared
// between users, and another account could plant "ok" verdicts there.
// Resolved per call so a changed HOME (tests, sandboxes) is honoured.
const stateDir = () => join(homedir(), ".failproofai", "slopsquat");
const cacheDir = () => join(stateDir(), "cache");
const memoryCache = new Map();
const TTL_MS = { ok: 24 * 3600_000, suspicious: 6 * 3600_000, missing: 3600_000 };

function cachePath(eco, name) {
  return join(cacheDir(), `${eco}-${createHash("sha1").update(name).digest("hex").slice(0, 20)}.json`);
}

function cacheGet(eco, name, cfg) {
  const key = `${eco}:${name}`;
  let entry = memoryCache.get(key);
  if (!entry) {
    try {
      entry = JSON.parse(readFileSync(cachePath(eco, name), "utf8"));
    } catch {
      return null;
    }
  }
  const { verdict } = assess(eco, entry.meta, cfg);
  if (Date.now() - entry.at > (TTL_MS[verdict] ?? 0)) return null;
  memoryCache.set(key, entry);
  return entry.meta;
}

function cachePut(eco, name, meta) {
  const entry = { at: Date.now(), meta };
  memoryCache.set(`${eco}:${name}`, entry);
  try {
    mkdirSync(cacheDir(), { recursive: true, mode: 0o700 });
    const file = cachePath(eco, name);
    const tmp = `${file}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(entry));
    renameSync(tmp, file);
  } catch {}
}

export async function lookup(eco, name, signal, cfg = DEFAULTS) {
  const cached = cacheGet(eco, name, cfg);
  if (cached) return cached;
  try {
    const meta = await LOOKUPS[eco](name, signal, cfg);
    cachePut(eco, name, meta);
    return meta;
  } catch (err) {
    return { status: "error", error: err?.name === "AbortError" || err?.name === "TimeoutError" ? "timed out" : String(err?.message ?? err) };
  }
}

// ---------------------------------------------------------------------------
// Assessment
// ---------------------------------------------------------------------------

const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;

export function assess(eco, meta, cfg = DEFAULTS, now = Date.now()) {
  if (meta.status === "missing") return { verdict: "missing", reasons: [] };
  if (meta.status !== "ok") return { verdict: "unknown", reasons: [meta.error ?? "lookup failed"] };
  const reasons = [];
  const ageDays = meta.createdAt ? Math.floor((now - meta.createdAt) / DAY_MS) : null;
  const young = ageDays !== null && ageDays < cfg.freshWindowDays;

  if (ageDays !== null && ageDays < cfg.minAgeDays) {
    const when = ageDays === 0 ? "today" : `${plural(ageDays, "day")} ago`;
    reasons.push(meta.ageBasis === "latest" ? `has no tagged releases and its latest code was published ${when}` : `was first published ${when}`);
  }
  if (eco === "npm" && meta.downloads !== null && meta.downloads !== undefined && meta.downloads < cfg.minWeeklyDownloadsNpm && (young || !meta.hasRepo)) {
    reasons.push(`had ${plural(meta.downloads, "download")} last week`);
  }
  if ((eco === "cargo" || eco === "gem") && meta.downloads !== null && meta.downloads !== undefined && meta.downloads < cfg.minTotalDownloads && (young || !meta.hasRepo)) {
    reasons.push(`has ${plural(meta.downloads, "download")} in total`);
  }
  if (young && meta.versionCount !== null && meta.versionCount !== undefined && meta.versionCount <= 1 && !meta.hasRepo) {
    reasons.push("has a single release and no linked source repository");
  }
  if (eco === "npm" && meta.installScripts && young) {
    reasons.push("runs an install script");
  }
  if (eco === "pypi" && meta.noFiles) {
    reasons.push("has no installable files (a placeholder registration)");
  }
  return { verdict: reasons.length ? "suspicious" : "ok", reasons };
}

// ---------------------------------------------------------------------------
// Decision
// ---------------------------------------------------------------------------

const fmt = (p) => `\`${p.name}\``;

function joinNames(list) {
  const names = list.map(fmt);
  return names.length <= 1 ? names.join("") : `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;
}

// ---- Pause-once warnings ----------------------------------------------------
//
// A warned package is remembered per session for pauseWindowMinutes. Keys are
// "eco:name" (or "dynamic:<spec>"), so a retry with different flags or a
// different order still counts as the same confirmation. State is kept in
// memory and in a small file, because hooks may run in a fresh process each
// time or inside the long-lived daemon worker.

const pauseFile = () => join(stateDir(), "pauses.json");
const pauseMemory = new Map();

// The file is the source of truth (shared by short-lived hook processes and
// the daemon worker); memory is the fallback when it cannot be read or written.
function readPauses() {
  try {
    const disk = JSON.parse(readFileSync(pauseFile(), "utf8"));
    if (disk && typeof disk === "object") return disk;
  } catch {}
  return Object.fromEntries(pauseMemory);
}

function writePauses(pauses, now, windowMs) {
  const fresh = Object.fromEntries(Object.entries(pauses).filter(([, at]) => now - at < windowMs));
  for (const [k, at] of Object.entries(fresh)) pauseMemory.set(k, at);
  try {
    mkdirSync(stateDir(), { recursive: true, mode: 0o700 });
    const tmp = `${pauseFile()}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(fresh));
    renameSync(tmp, pauseFile());
  } catch {}
}

const pauseKey = (sessionId, item) => `${sessionId ?? "no-session"}|${item.key}`;

// Splits warn items into those already confirmed (warned recently in this
// session) and those still pending; records the pending ones.
function settlePauses(items, sessionId, cfg, now = Date.now()) {
  const windowMs = Math.max(1, Number(cfg.pauseWindowMinutes) || DEFAULTS.pauseWindowMinutes) * 60_000;
  const pauses = readPauses();
  const pending = items.filter((it) => !(now - (pauses[pauseKey(sessionId, it)] ?? -Infinity) < windowMs));
  if (pending.length) {
    for (const it of pending) pauses[pauseKey(sessionId, it)] = now;
    writePauses(pauses, now, windowMs);
  }
  return { pending, confirmed: items.filter((it) => !pending.includes(it)) };
}

// ---- Decision -----------------------------------------------------------------

const lookupMode = (cfg) => (cfg.onLookupError === "instruct" ? "warn" : ["warn", "allow", "deny"].includes(cfg.onLookupError) ? cfg.onLookupError : "warn");

// Look every package up in parallel under one deadline and fold the results
// into a single decision. `action` names what is being judged ("install",
// "edit to package.json") for the messages. `dynamic` lists specs whose names
// are only known at run time.
export async function check(packages, { cfg = DEFAULTS, cwd, action = "install", sessionId, dynamic = [] } = {}) {
  const wanted = packages.filter((p) => !isSkipped(p, cfg, cwd));
  if (!wanted.length && !dynamic.length) return allow();
  const batch = wanted.slice(0, cfg.maxPackages);
  const overflow = wanted.slice(cfg.maxPackages);

  let results = [];
  if (batch.length) {
    const deadline = new AbortController();
    const timer = setTimeout(() => deadline.abort(), cfg.deadlineMs);
    try {
      results = await Promise.all(
        batch.map(async (p) => {
          const signal =
            typeof AbortSignal.any === "function"
              ? AbortSignal.any([deadline.signal, AbortSignal.timeout(cfg.requestTimeoutMs)])
              : deadline.signal;
          const meta = await lookup(p.eco, p.name, signal, cfg);
          return { ...p, meta, ...assess(p.eco, meta, cfg) };
        }),
      );
    } finally {
      clearTimeout(timer);
    }
  }

  // 1. Names that do not exist: always a hard block.
  const missing = results.filter((r) => r.verdict === "missing");
  if (missing.length) {
    const byEco = Object.groupBy
      ? Object.groupBy(missing, (r) => r.eco)
      : missing.reduce((acc, r) => ((acc[r.eco] ??= []).push(r), acc), {});
    const parts = Object.entries(byEco).map(([eco, list]) => {
      const gone = list.filter((r) => r.meta.unpublished);
      const absent = list.filter((r) => !r.meta.unpublished);
      const bits = [];
      if (absent.length) bits.push(`${joinNames(absent)} ${absent.length === 1 ? "does" : "do"} not exist on ${REGISTRY_LABEL[eco]}`);
      if (gone.length) bits.push(`${joinNames(gone)} ${gone.length === 1 ? "was" : "were"} unpublished from ${REGISTRY_LABEL[eco]}`);
      return bits.join("; ");
    });
    return deny(
      `Slopsquatting guard blocked this ${action}: ${parts.join("; ")}. ` +
        `The name is likely hallucinated, and anyone can register it later with malicious code. ` +
        `Find the exact package name in the library's official documentation or repository and use that. ` +
        `Do not try spelling variants of this name. If it is a private package, ask the user to add it to the slopsquat guard's allow list (its "allow" param).`,
    );
  }

  // 2. Everything that deserves a warning.
  const warn = results
    .filter((r) => r.verdict === "suspicious")
    .map((r) => ({ key: `${r.eco}:${r.name}`, text: `${fmt(r)} on ${REGISTRY_LABEL[r.eco]} ${r.reasons.join(", ")}` }));
  const unverified = [
    ...results
      .filter((r) => r.verdict === "unknown")
      .map((r) => ({ key: `${r.eco}:${r.name}`, text: `${fmt(r)} could not be verified (${r.reasons[0] ?? "registry unreachable"})` })),
    ...overflow.map((p) => ({ key: `${p.eco}:${p.name}`, text: `${fmt(p)} was not checked (over the ${cfg.maxPackages}-package per-call limit)` })),
    ...dynamic.map((d) => ({ key: `dynamic:${d.spec}`, text: `\`${d.spec}\` could not be checked (the package name is only known when the command runs)` })),
  ];
  const mode = lookupMode(cfg);
  if (mode === "deny" && unverified.length) {
    return deny(
      `Slopsquat guard blocked this ${action}: ${unverified.map((u) => u.text).join("; ")}. ` +
        `Name each package explicitly and check it exists, or ask the user to install it themselves.`,
    );
  }
  if (mode === "warn") warn.push(...unverified);

  if (warn.length) {
    const { pending, confirmed } = settlePauses(warn, sessionId, cfg);
    if (!pending.length) {
      return allow(`Slopsquat guard: proceeding after the earlier warning about ${confirmed.map((c) => c.key.replace(/^[^:]+:/, "")).join(", ")}.`);
    }
    const minutes = Number(cfg.pauseWindowMinutes) || DEFAULTS.pauseWindowMinutes;
    return deny(
      `PAUSED by the slopsquat guard. This is a warning, not a permanent block. ` +
        `This ${action} pulls in ${pending.length === 1 ? "a package that needs" : "packages that need"} a second look: ${pending.map((p) => p.text).join("; ")}. ` +
        `Newly registered, low-traffic and unverifiable packages are how slopsquatting attacks land. ` +
        `Tell the user which package this is and why you need it, and ask them to confirm it is the intended one. ` +
        `If they confirm, run the same command again within ${plural(minutes, "minute")} and it will go through. ` +
        `Do not switch to a differently spelled package or a URL install to get around this.`,
    );
  }

  if (mode === "allow" && unverified.length) {
    return allow(`Slopsquat guard ${unverified.map((u) => u.text).join("; ")}.`);
  }
  return allow();
}

// ---------------------------------------------------------------------------
// Policies
// ---------------------------------------------------------------------------

// A policy that throws is treated as ALLOW by Failproof. Catch everything and
// decide deliberately: deny only when the user chose onLookupError "deny".
function failSafe(cfg, err) {
  const msg = `Slopsquat guard hit an internal error (${err?.message ?? err}).`;
  return lookupMode(cfg) === "deny" ? deny(`${msg} Ask the user before installing.`) : allow(msg);
}

customPolicies.add({
  name: "slopsquat-install-guard",
  description: "Check packages a shell command installs against their registry: deny names that do not exist, pause once on new, low-traffic or unverifiable ones",
  category: "Supply chain",
  defaultEnabled: true,
  match: { events: ["PreToolUse"] },
  params: PARAMS_SCHEMA,
  fn: async (ctx) => {
    if (ctx.toolName !== "Bash") return allow();
    const cfg = config(ctx);
    try {
      const { packages, dynamic } = inspectCommand(String(ctx.toolInput?.command ?? ""));
      if (!packages.length && !dynamic.length) return allow();
      return await check(packages, { cfg, cwd: ctx.session?.cwd, action: "install", sessionId: ctx.session?.sessionId, dynamic });
    } catch (err) {
      return failSafe(cfg, err);
    }
  },
});

customPolicies.add({
  name: "slopsquat-manifest-guard",
  description: "Check dependencies added to package.json, requirements, pyproject, Cargo.toml, go.mod or Gemfile against their registry",
  category: "Supply chain",
  defaultEnabled: true,
  match: { events: ["PreToolUse"] },
  params: PARAMS_SCHEMA,
  fn: async (ctx) => {
    if (!["Write", "Edit", "MultiEdit"].includes(ctx.toolName)) return allow();
    const cfg = config(ctx);
    try {
      const cwd = ctx.session?.cwd;
      const packages = extractFromManifestEdit(ctx.toolName, ctx.toolInput ?? {}, cwd);
      if (!packages.length) return allow();
      const file = basename(String(ctx.toolInput?.file_path ?? "the manifest"));
      return await check(packages, { cfg, cwd, action: `edit to ${file}`, sessionId: ctx.session?.sessionId });
    } catch (err) {
      return failSafe(cfg, err);
    }
  },
});
