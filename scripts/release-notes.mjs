import { readFileSync } from "node:fs";

const [version, changelogPath = "packages/pi-unified-exec/CHANGELOG.md"] =
  process.argv.slice(2);
if (!/^\d+\.\d+\.\d+$/.test(version ?? "")) {
  throw new Error("usage: node scripts/release-notes.mjs <X.Y.Z>");
}

const changelog = readFileSync(changelogPath, "utf8");
const heading = new RegExp(
  `^## \\[${version.replaceAll(".", "\\.")}\\] - .+$`,
  "m",
);
const match = heading.exec(changelog);
if (!match || match.index === undefined) {
  throw new Error(`missing @chensl/pi-unified-exec changelog entry for ${version}`);
}

const body = changelog
  .slice(match.index + match[0].length)
  .split(/^## \[/m, 1)[0]
  .trim();
console.log(`## pi-unified-exec v${version}\n\n${body}`);
