// `node --import ./slopsquat/test/register-stub.mjs …` resolves the bare
// `failproofai` import to the local stub.
import { register } from "node:module";

register(
  `data:text/javascript,${encodeURIComponent(`
    const stub = ${JSON.stringify(new URL("./failproofai-stub.mjs", import.meta.url).href)};
    export async function resolve(specifier, context, next) {
      if (specifier === "failproofai") return { url: stub, shortCircuit: true };
      return next(specifier, context);
    }
  `)}`,
);
