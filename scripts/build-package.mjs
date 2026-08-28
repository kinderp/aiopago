import { readFile, writeFile } from "node:fs/promises";
import { rmSync } from "node:fs";
import { build } from "esbuild";

rmSync("dist", { recursive: true, force: true });

const removeSourceTestSupport = {
  name: "remove-source-test-support",
  setup(buildContext) {
    buildContext.onLoad({ filter: /[\\/]src[\\/](?:storage|runner)\.mjs$/ }, async ({ path }) => ({
      contents: (await readFile(path, "utf8")).replace(
        /[ \t]*\/\/ @source-test-support-start[\s\S]*?[ \t]*\/\/ @source-test-support-end\r?\n?/g,
        "",
      ),
      loader: "js",
    }));
  },
};

const common = {
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22.19",
  packages: "external",
  charset: "utf8",
  legalComments: "none",
  banner: { js: "const __AIOPAGO_OPERATIONAL_ENTRY_URL__ = import.meta.url;" },
  sourcemap: false,
  minify: false,
  treeShaking: true,
  logLevel: "warning",
  plugins: [removeSourceTestSupport],
};

await Promise.all([
  build({ ...common, entryPoints: ["src/index.mjs"], outfile: "dist/index.mjs" }),
  build({ ...common, entryPoints: ["src/cli-entry.mjs"], outfile: "dist/cli-entry.mjs" }),
  build({ ...common, entryPoints: ["src/operation-authority-worker.mjs"], outfile: "dist/operation-authority-worker.mjs" }),
]);

// The shipped operational artifact must be inert even when Node selects it as
// a Worker or process entry. Keep all authority lexical in the bundle, but
// remove the sole source invocation. The bin's sanitized child reads these
// exact bytes and appends that invocation only inside the fresh process.
const operationalPath = "dist/cli-entry.mjs";
const invocation = "await aiopagoOperationalEntrypoint();";
const operational = await readFile(operationalPath, "utf8");
const occurrences = operational.split(invocation).length - 1;
if (occurrences !== 1) throw new Error(`Expected exactly one operational invocation, found ${occurrences}`);
await writeFile(operationalPath, operational.replace(`${invocation}\n`, ""));
