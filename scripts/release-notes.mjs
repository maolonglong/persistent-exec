import { readFileSync } from "node:fs";

const [version, changelogPath = "packages/pi-persistent-exec/CHANGELOG.md"] =
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
  throw new Error(`missing pi-persistent-exec changelog entry for ${version}`);
}

const body = changelog
  .slice(match.index + match[0].length)
  .split(/^## \[/m, 1)[0]
  .trim();
console.log(`## persistent-exec v${version}\n\n${body}`);
