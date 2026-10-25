// Stand-in for the `failproofai` module so the policy file loads under plain
// `node --test`. Mirrors the decision helpers in src/hooks/policy-helpers.ts.

export const registered = [];

export const customPolicies = {
  add(policy) {
    registered.push(policy);
  },
};

export const allow = (reason) => (reason ? { decision: "allow", reason } : { decision: "allow" });
export const deny = (reason) => ({ decision: "deny", reason });
export const instruct = (reason) => ({ decision: "instruct", reason });

export function policy(name) {
  const p = registered.find((r) => r.name === name);
  if (!p) throw new Error(`policy ${name} was not registered`);
  return p;
}
