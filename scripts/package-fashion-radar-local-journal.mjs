import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const output = process.argv[2];
if (!output) throw new Error("Set the installer output directory.");
const destination = resolve(output);
const source = fileURLToPath(new URL("../tools/fashion-radar-local-journal/", import.meta.url));
const zodPath = dirname(createRequire(import.meta.url).resolve("zod/package.json"));
await mkdir(destination, { recursive: true });
await Promise.all([
  build({
    entryPoints: [join(source, "runtime.mjs")], outfile: join(destination, "collector.mjs"),
    bundle: true, platform: "node", target: "node22", format: "esm", minify: true, legalComments: "inline",
  }),
  ...["install.mjs", "patch.mjs", "README.md"].map((name) => copyFile(join(source, name), join(destination, name))),
  copyFile(join(zodPath, "LICENSE"), join(destination, "LICENSE-zod.txt")),
  readFile(join(source, "Install-Local-Journal.cmd"), "utf8").then((source) =>
    writeFile(join(destination, "Install-Local-Journal.cmd"), source.replace(/\r?\n/g, "\r\n"))),
]);
