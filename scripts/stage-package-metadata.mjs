import { copyFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const [packageName] = process.argv.slice(2);
if (!packageName) {
  throw new Error("usage: node scripts/stage-package-metadata.mjs <package>");
}

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const packageDirectory = resolve(projectRoot, "packages", packageName);
copyFileSync(resolve(projectRoot, "LICENSE"), resolve(packageDirectory, "LICENSE"));
copyFileSync(resolve(projectRoot, "NOTICE"), resolve(packageDirectory, "NOTICE"));
