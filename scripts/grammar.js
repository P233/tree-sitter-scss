const { execFileSync, spawnSync } = require("node:child_process");
const { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { dirname, join } = require("node:path");

const root = join(__dirname, "..");
// Child processes run from the checkout with bounded, captured output.
const childOptions = {
  cwd: root,
  encoding: "utf8",
  timeout: 30_000,
  maxBuffer: 16 * 1024 * 1024,
  stdio: ["ignore", "pipe", "pipe"]
};
// States past Tree-sitter's small-state threshold become dense symbol-width rows, which dominate parser size.
const LARGE_STATE_BUDGET = 525;
const executable = join(
  dirname(require.resolve("tree-sitter-cli/package.json")),
  process.platform === "win32" ? "tree-sitter.exe" : "tree-sitter"
);

function runTreeSitter(args, { reportWarnings = false, inherit = false } = {}) {
  const result = spawnSync(executable, args, {
    ...childOptions,
    // Foreground CLI commands retain their terminal and may intentionally run longer than preview requests.
    ...(inherit ? { stdio: "inherit", timeout: undefined } : {}),
    // The CLI keys compiled libraries by grammar name, so keep worktrees isolated.
    env: { ...process.env, TREE_SITTER_LIBDIR: join(root, "build/tree-sitter") }
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    const reason = result.signal || `exit status ${result.status}`;
    throw Object.assign(new Error(`tree-sitter ${args[0]} failed with ${reason}`), {
      stdout: result.stdout,
      stderr: result.stderr,
      exitCode: result.status || 1
    });
  }
  // Successful generation still reports grammar warnings, such as unnecessary conflicts.
  if (reportWarnings && result.stderr) process.stderr.write(result.stderr);
  return result.stdout;
}

function build() {
  return execFileSync(process.execPath, [require.resolve("node-gyp/bin/node-gyp.js"), "rebuild"], childOptions);
}

function generate(output) {
  return runTreeSitter(["generate", "--abi", "14", ...(output ? ["--output", output] : [])], { reportWarnings: true });
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

function largeStateCount(directory) {
  const match = readFileSync(join(directory, "parser.c"), "utf8").match(/^#define LARGE_STATE_COUNT (\d+)$/m);
  if (!match) throw new Error(`LARGE_STATE_COUNT is missing from ${join(directory, "parser.c")}.`);
  return Number(match[1]);
}

function checkLargeStates(directory, budget = LARGE_STATE_BUDGET) {
  const count = largeStateCount(directory);
  if (count > budget) {
    throw new Error(
      `Generated parser has ${count} large parse states, over the budget of ${budget}. ` +
        "Look for a rule or token choice that became valid in many states before raising the budget."
    );
  }
  return count;
}

function checkGenerated() {
  const output = mkdtempSync(join(tmpdir(), "scss-generated-"));
  try {
    generate(output);
    const differences = generatedDifferences(output, join(root, "src"));
    if (differences.length) {
      throw new Error(`Generated files are stale: ${differences.join(", ")}. Run pnpm generate.`);
    }
    return checkLargeStates(output);
  } finally {
    rmSync(output, { recursive: true, force: true });
  }
}

if (require.main === module) {
  try {
    const [command, ...args] = process.argv.slice(2);
    if (command === "--build") {
      build();
    } else if (command === "--check") {
      const largeStates = checkGenerated();
      console.log(
        `Generated files match grammar.js (ABI 14); ${largeStates}/${LARGE_STATE_BUDGET} large parse states.`
      );
    } else if (["test", "parse", "highlight"].includes(command)) {
      runTreeSitter([command, "--config-path", "test/config.json", "--grammar-path", ".", ...args], { inherit: true });
    } else if (command === undefined) {
      generate();
    } else {
      throw new Error(`Unknown grammar command: ${command}`);
    }
  } catch (error) {
    if (error.stdout) process.stdout.write(error.stdout);
    console.error(error.stderr || error.message);
    process.exitCode = error.exitCode || 1;
  }
}

module.exports = {
  root,
  childOptions,
  runTreeSitter,
  generate,
  build,
  generatedDifferences,
  checkLargeStates,
  checkGenerated
};
