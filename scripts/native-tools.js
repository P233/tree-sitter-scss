const { createHash } = require("node:crypto");
const { readFileSync, readdirSync } = require("node:fs");
const { createRequire } = require("node:module");
const { dirname, join } = require("node:path");

const hash = source => createHash("sha256").update(source).digest("hex");

function sourceHash(directory) {
  return hash(
    readdirSync(directory, { recursive: true })
      .filter(path => /\.[ch]$/.test(path))
      .sort()
      .map(path => `${path}\0${hash(readFileSync(join(directory, path)))}\n`)
      .join("")
  );
}

function runtimeFor(root) {
  const local = createRequire(join(root, "package.json"));
  return {
    directory: join(dirname(local.resolve("tree-sitter/package.json")), "vendor/tree-sitter/lib"),
    version: local("tree-sitter/package.json").version
  };
}

module.exports = { hash, sourceHash, runtimeFor };
