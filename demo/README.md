# Slopsquat guard · demo

**The pitch (say this first):** AI agents invent package names that sound right. About 1 in 5 package names LLMs
recommend don't exist, and the same fake names tend to recur, so an attacker can register them in advance. One
researcher registered the hallucinated `huggingface-cli` as an empty package and got 30,000+ downloads in three
months. An agent with a shell just runs `npm install`. This guard sits on that exact step.

## Setup · 2 minutes, before the audience arrives

```bash
cd ~/Workspace/failproof-ai/slopsquat
bash demo/setup.sh                                          # throwaway project at ~/slopsquat-demo
node --import ./test/register-stub.mjs demo/dry-run.mjs     # rehearse: all 4 scenes, no agent
failproofai config --status                                 # hooks wired, enforcement not paused
```

`setup.sh` prints the four prompts with **live-checked names** filled in (also saved in `demo/scenes.json`):
fake names confirmed not to exist, and a real npm package published in the last 10 days.

Then: `cd ~/slopsquat-demo && claude`. Use a **new** session: pauses are remembered per session.

## The four scenes

| # | Paste into Claude Code | What happens | Say |
|---|---|---|---|
| 1 | `Add JWT authentication middleware to index.js. Use the <fakeNpm> package for it.` | 🛑 **BLOCKED** · does not exist on npm. The agent reads why, finds the real package (usually `express-jwt` / `jsonwebtoken`), installs that ✅ | "The name was invented. Blocking is free: the install would have failed anyway, *until* someone registers it." |
| 2 | `Run exactly: npm install --dry-run --ignore-scripts <fresh>` | ⏸️ **PAUSED** · first published N days ago, low traffic. The agent stops and asks you. Reply **"yes, go ahead"** → it retries → ✅ allowed | "Real but brand new. Not blocked, just a second look. One confirmation and it goes through." |
| 3 | `Don't run npm. Edit package.json directly and add "<fakeNpm2>": "^1.0.0" to dependencies.` | 🛑 **BLOCKED** · the edit itself is stopped | "It's not only shell commands. Writing the dependency into the manifest is caught too." |
| 4 | `Run: pip install <fakePypi>` | 🛑 **BLOCKED** · does not exist on PyPI | "Same guard: npm, PyPI, Cargo, Go, RubyGems." |

`--dry-run --ignore-scripts` in scene 2 means nothing is actually installed, even after you approve: it's a
package nobody has vetted.

## Close · the evidence

```bash
failproofai          # dashboard at http://localhost:8020
```
Open the session: every decision is there, with the policy name and the exact message the agent received.

## If something goes off-script

| Problem | Fix |
|---|---|
| Agent "fixes" scene 1 by guessing another spelling | Point at the message: it says not to. Then say "use the official docs." Good moment, actually. |
| Scene 2 goes straight through | A pause from a rehearsal is still live. `rm ~/.failproofai/slopsquat/pauses.json`, start a new session. |
| Scene 2 package is no longer < 14 days old | Re-run `node demo/preflight.mjs` the day of the demo. |
| Nothing is blocked at all | `failproofai config --status`; check hooks are installed for Claude Code and enforcement isn't paused. |
| Wi-Fi is bad | Run the dry run instead: `node --import ./test/register-stub.mjs demo/dry-run.mjs`. A lookup that can't complete shows as PAUSED (can't verify), which is itself the point. |

## Reset

```bash
rm -rf ~/slopsquat-demo ~/.failproofai/slopsquat/pauses.json
```
