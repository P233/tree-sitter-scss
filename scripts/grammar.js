const { execFileSync } = require("node:child_process");
const { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { dirname, join } = require("node:path");

const root = join(__dirname, "..");
const executable = join(
  dirname(require.resolve("tree-sitter-cli/package.json")),
  process.platform === "win32" ? "tree-sitter.exe" : "tree-sitter"
);

function runTreeSitter(args) {
  return execFileSync(executable, args, {
    cwd: root,
    encoding: "utf8",
    timeout: 30_000,
    maxBuffer: 16 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"]
  });
}

function build() {
  return execFileSync(process.execPath, [require.resolve("node-gyp/bin/node-gyp.js"), "rebuild"], {
    cwd: root,
    encoding: "utf8",
    timeout: 30_000,
    maxBuffer: 16 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"]
  });
}

function generate(output) {
  return runTreeSitter(["generate", "--abi", "14", ...(output ? ["--output", output] : [])]);
}

function generatedDifferences(expected, actual, relative = "") {
  return readdirSync(join(expected, relative), { withFileTypes: true }).flatMap(entry => {
    const name = join(relative, entry.name);
    if (entry.isDirectory()) return generatedDifferences(expected, actual, name);
    const destination = join(actual, name);
    return !existsSync(destination) || !readFileSync(join(expected, name)).equals(readFileSync(destination))
      ? [name]
      : [];
  });
}

function checkGenerated() {
  const output = mkdtempSync(join(tmpdir(), "scss-generated-"));
  try {
    generate(output);
    const differences = generatedDifferences(output, join(root, "src"));
    if (differences.length) {
      throw new Error(`Generated files are stale: ${differences.join(", ")}. Run pnpm generate.`);
    }
  } finally {
    rmSync(output, { recursive: true, force: true });
  }
}

if (require.main === module) {
  try {
    if (process.argv.includes("--build")) {
      build();
    } else if (process.argv.includes("--check")) {
      checkGenerated();
      console.log("Generated files match grammar.js (ABI 14).");
    } else {
      generate();
    }
  } catch (error) {
    console.error(error.stderr || error.message);
    process.exitCode = 1;
  }
}

module.exports = { root, runTreeSitter, generate, build, generatedDifferences, checkGenerated };
