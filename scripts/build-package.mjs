import { readFile } from "node:fs/promises";
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
  sourcemap: false,
  minify: false,
  treeShaking: true,
  logLevel: "warning",
  plugins: [removeSourceTestSupport],
};

await Promise.all([
  build({ ...common, entryPoints: ["src/index.mjs"], outfile: "dist/index.mjs" }),
  build({ ...common, entryPoints: ["src/cli-entry.mjs"], outfile: "dist/cli-entry.mjs" }),
]);
