#!/usr/bin/env node
/**
 * Keeps the `version` constant exported from src/index.ts in step with
 * package.json.
 *
 * Run automatically by npm's `version` lifecycle hook, which fires after
 * package.json is bumped and before the release commit is created — so the
 * corrected source is part of the same commit and tag.
 *
 * Without this the two drift silently: 1.0.2 shipped to npm while still
 * reporting `version === "1.0.1"` to consumers, because `npm version patch`
 * only ever touches package.json.
 */
import { readFileSync, writeFileSync } from "node:fs";

const SOURCE = new URL("../src/index.ts", import.meta.url);
const PATTERN = /export const version = "(.*?)";/;

const { version } = JSON.parse(
  readFileSync(new URL("../package.json", import.meta.url), "utf8"),
);

const source = readFileSync(SOURCE, "utf8");
const match = source.match(PATTERN);

if (!match) {
  console.error(
    "sync-version: could not find `export const version = \"...\"` in src/index.ts.\n" +
      "The constant was renamed or removed — update scripts/sync-version.mjs to match.",
  );
  process.exit(1);
}

if (match[1] === version) {
  console.log(`sync-version: already ${version}`);
  process.exit(0);
}

writeFileSync(SOURCE, source.replace(PATTERN, `export const version = "${version}";`));
console.log(`sync-version: ${match[1]} -> ${version}`);
