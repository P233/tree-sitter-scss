const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const { mkdtempSync, readFileSync, rmSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join } = require("node:path");

const root = join(__dirname, "..");
const temporary = mkdtempSync(join(tmpdir(), "scss-package-check-"));
const shared = [
  "LICENSE",
  "README.md",
  "grammar.js",
  "queries/highlights.scm",
  "src/grammar.json",
  "src/node-types.json",
  "src/parser.c",
  "src/scanner.c",
  "src/tree_sitter/alloc.h",
  "src/tree_sitter/array.h",
  "src/tree_sitter/parser.h",
  "tree-sitter.json"
];

function run(command, args) {
  return execFileSync(command, args, { cwd: root, encoding: "utf8", timeout: 60_000 });
}

function checkFiles(actual, required, optional = []) {
  for (const file of required) assert.ok(actual.includes(file), `Package is missing ${file}`);
  const allowed = new Set([...required, ...optional]);
  assert.deepEqual(
    actual.filter(file => !allowed.has(file)),
    [],
    "Package contains unrelated files"
  );
}

try {
  const metadata = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  const grammar = JSON.parse(readFileSync(join(root, "tree-sitter.json"), "utf8"));
  const cargo = readFileSync(join(root, "Cargo.toml"), "utf8");
  assert.equal(grammar.metadata.version, metadata.version, "Tree-sitter metadata version has drifted");
  assert.equal(cargo.match(/^version = "([^"]+)"/m)?.[1], metadata.version, "Cargo version has drifted");

  const [npm] = JSON.parse(
    run("npm", ["pack", "--dry-run", "--ignore-scripts", "--json", "--cache", join(temporary, "cache")])
  );
  checkFiles(
    npm.files.map(file => file.path),
    [...shared, "package.json", "binding.gyp", "bindings/node/binding.cc", "bindings/node/index.js"]
  );
  const crate = run("cargo", ["package", "--list", "--allow-dirty"]).trim().split(/\r?\n/);
  checkFiles(
    crate,
    [...shared, "Cargo.toml", "Cargo.toml.orig", "Cargo.lock", "bindings/rust/build.rs", "bindings/rust/lib.rs"],
    [".cargo_vcs_info.json"]
  );
  console.log(`Parser-only package contents verified: npm ${npm.files.length} files; Cargo ${crate.length} files.`);
} finally {
  rmSync(temporary, { recursive: true, force: true });
}
