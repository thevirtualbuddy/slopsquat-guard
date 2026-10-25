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
mkdir -p "$DEMO_DIR/.failproofai/policies"

# Project-scoped: Failproof loads <project>/.failproofai/policies/*policies.mjs
# automatically, for this project only. The file name must end in policies.mjs.
cp "$REPO/slopsquat.mjs" "$DEMO_DIR/.failproofai/policies/slopsquat-policies.mjs"

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

echo "→ Validating the policy with Failproof"
(cd "$DEMO_DIR" && failproofai policies --install --custom .failproofai/policies/slopsquat-policies.mjs --scope project)

# A pause from a previous rehearsal would let scene 2 straight through.
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
