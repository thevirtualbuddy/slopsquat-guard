#!/usr/bin/env bash
# Sets up a throwaway project with the slopsquat guard installed for that
# project only, then picks live package names for each demo scene.
#
#   bash demo/setup.sh              # demo project at ~/slopsquat-demo
#   bash demo/setup.sh /some/dir    # somewhere else
#
# Safe to re-run: it refreshes the policy copy, clears earlier pauses and
# picks fresh names.
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DEMO_DIR="${1:-$HOME/slopsquat-demo}"

command -v failproofai >/dev/null || { echo "failproofai is not installed (npm install -g failproofai)"; exit 1; }
command -v node >/dev/null || { echo "node is not installed"; exit 1; }

echo "→ Demo project: $DEMO_DIR"
mkdir -p "$DEMO_DIR"

# If the published pack is installed machine-wide, it already guards this
# project; a second, project-scoped copy would make every check run twice.
PACKS="$HOME/.failproofai/policies/packs/installed.json"
if [ -f "$PACKS" ] && grep -q "slopsquat-guard" "$PACKS"; then
  echo "→ The slopsquat-guard pack is installed machine-wide; using it (no project copy)"
  rm -f "$DEMO_DIR/.failproofai/policies/slopsquat-policies.mjs"
else
  # Project-scoped: Failproof loads <project>/.failproofai/policies/*policies.mjs
  # automatically, for this project only. The file name must end in policies.mjs.
  mkdir -p "$DEMO_DIR/.failproofai/policies"
  POLICY="$DEMO_DIR/.failproofai/policies/slopsquat-policies.mjs"
  cp "$REPO/slopsquat.mjs" "$POLICY"
  # Load check only. Deliberately NOT `failproofai policies --install`: that
  # also wires a second set of Claude Code hooks into the project, so every
  # policy would run twice alongside the user-level hooks.
  echo "→ Checking the policy loads"
  node --import "$REPO/test/register-stub.mjs" --input-type=module -e "
    const { registered } = await import('$REPO/test/failproofai-stub.mjs');
    await import('$POLICY');
    const names = registered.map((p) => p.name);
    if (names.length < 2) { console.error('  expected 2 policies, got: ' + names.join(', ')); process.exit(1); }
    console.log('  loaded: ' + names.join(', '));
  "
fi

if [ ! -f "$DEMO_DIR/package.json" ]; then
  cat > "$DEMO_DIR/package.json" <<'EOF'
{
  "name": "slopsquat-demo",
  "version": "1.0.0",
  "private": true,
  "type": "module",
  "main": "index.js",
  "dependencies": {
    "express": "^4.21.0"
  }
}
EOF
  cat > "$DEMO_DIR/index.js" <<'EOF'
import express from "express";

const app = express();
app.use(express.json());

app.get("/health", (_req, res) => res.json({ ok: true }));
app.get("/me", (req, res) => res.json({ user: req.user ?? null }));

app.listen(3000, () => console.log("listening on :3000"));
EOF
fi

if [ -f "$DEMO_DIR/.claude/settings.json" ] && grep -q "failproofai" "$DEMO_DIR/.claude/settings.json"; then
  echo "▲ $DEMO_DIR/.claude/settings.json has Failproof hooks (an earlier version of this script added them)."
  echo "  With your user-level hooks that runs every policy twice. Remove it:  rm -rf $DEMO_DIR/.claude"
fi

# Pauses are per Claude Code session, so a new session is the real reset;
# this clears rehearsal leftovers too.
rm -f "$HOME/.failproofai/slopsquat/pauses.json"

echo "→ Picking live package names"
node "$REPO/demo/preflight.mjs"

cat <<EOF

Next:
  1. failproofai config --status        # hooks wired, enforcement not paused
  2. cd $DEMO_DIR && claude              # start a NEW Claude Code session here
  3. Paste the scene prompts above, in order
  4. failproofai                         # dashboard at localhost:8020 for the recap
EOF
