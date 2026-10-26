#!/usr/bin/env bash
# Sets up the throwaway demo project, picks live package names for each scene
# and commits the starting state so every run starts from the same point.
#
#   bash demo/setup.sh                    # demo project at ~/orders-api
#   bash demo/setup.sh --fresh            # delete it and rebuild from scratch
#   bash demo/setup.sh [--fresh] /some/dir
#
# Start over:  git -C ~/orders-api reset --hard -q && git -C ~/orders-api clean -fdxq
#
# The project is deliberately named like an ordinary service (orders-api):
# a name that mentions slopsquatting tips the agent off before the guard is
# ever involved.
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
FRESH=0
if [ "${1:-}" = "--fresh" ]; then FRESH=1; shift; fi
DEMO_DIR="${1:-$HOME/orders-api}"
# Where setup.sh last built the project (git-ignored). --fresh deletes only
# that exact folder, never one that merely shares the name.
MARKER="$REPO/demo/.demo-dir"

command -v failproofai >/dev/null || { echo "failproofai is not installed (npm install -g failproofai)"; exit 1; }
command -v node >/dev/null || { echo "node is not installed"; exit 1; }
command -v git >/dev/null || { echo "git is not installed"; exit 1; }

if [ "$FRESH" = 1 ] && [ -e "$DEMO_DIR" ]; then
  ABS="$(cd "$DEMO_DIR" && pwd)"
  if [ -f "$MARKER" ] && [ "$(cat "$MARKER")" = "$ABS" ] && [ -f "$ABS/SETUP.md" ]; then
    rm -rf "$ABS"
    echo "→ Removed the old demo project"
  elif [ -z "$(ls -A "$ABS" 2>/dev/null)" ]; then
    rmdir "$ABS"
  else
    echo "Refusing to delete $DEMO_DIR: setup.sh did not build it. Pick another folder or remove it yourself."
    exit 1
  fi
fi

mkdir -p "$DEMO_DIR"
DEMO_DIR="$(cd "$DEMO_DIR" && pwd)"
echo "→ Demo project: $DEMO_DIR"

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

# Pauses are per agent session, so a new session is the real reset; this
# clears leftovers from earlier runs too.
rm -f "$HOME/.failproofai/slopsquat/pauses.json"

echo "→ Picking live package names"
DEMO_DIR="$DEMO_DIR" node "$REPO/demo/preflight.mjs"

echo "→ Writing the demo project"
# Also replaces a .claude/settings.json from an earlier version of this script
# that carried a second set of Failproof hooks.
node "$REPO/demo/scaffold.mjs" "$DEMO_DIR"

# A commit of the starting state, so each run can be reset to it.
if [ ! -d "$DEMO_DIR/.git" ]; then git -C "$DEMO_DIR" init -q; fi
git -C "$DEMO_DIR" add -A
git -C "$DEMO_DIR" -c user.name="Developer" -c user.email="dev@example.com" \
  commit -q -m "Initial commit" --allow-empty
echo "$DEMO_DIR" > "$MARKER"
echo "  committed the starting state"

cat <<EOF

Next:
  1. failproofai config --status                     # hooks wired, enforcement not paused
  2. cd $DEMO_DIR && claude                          # a new session for each run
  3. Paste the prompts above, in order
  4. failproofai                                     # localhost:8020 → Policies → Activity

Start over:
  git -C $DEMO_DIR reset --hard -q && git -C $DEMO_DIR clean -fdxq
EOF
