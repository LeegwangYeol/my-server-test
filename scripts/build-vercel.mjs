#!/usr/bin/env node
import { build } from "esbuild";
import { mkdir, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";

const root = process.cwd();
const out = join(root, ".vercel/output");
const fnDir = join(out, "functions/index.func");

await rm(out, { recursive: true, force: true });
await mkdir(join(out, "static"), { recursive: true });
await mkdir(fnDir, { recursive: true });

console.log("Bundling lambda-src/handler.ts ...");
await build({
  entryPoints: [join(root, "lambda-src/handler.ts")],
  bundle: true,
  platform: "node",
  target: "node20",
  format: "cjs",
  outfile: join(fnDir, "index.js"),
  logLevel: "info",
  legalComments: "none",
  minify: false,
});

await writeFile(
  join(fnDir, ".vc-config.json"),
  JSON.stringify(
    {
      runtime: "nodejs20.x",
      handler: "index.js",
      launcherType: "Nodejs",
      shouldAddHelpers: true,
    },
    null,
    2,
  ),
);

await writeFile(
  join(fnDir, "package.json"),
  JSON.stringify({ type: "commonjs" }, null, 2),
);

await writeFile(
  join(out, "config.json"),
  JSON.stringify(
    {
      version: 3,
      routes: [{ src: "^/(.*)$", dest: "/index" }],
    },
    null,
    2,
  ),
);

console.log("Build Output API v3 ready at .vercel/output/");
