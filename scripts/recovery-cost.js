const { Buffer } = require("node:buffer");
const { execFileSync } = require("node:child_process");
const { createHash } = require("node:crypto");
const { cpSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } = require("node:fs");
const { createRequire } = require("node:module");
const { cpus, tmpdir } = require("node:os");
const { dirname, join, resolve } = require("node:path");
const { parseArgs } = require("node:util");

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

// The scanner the ablation below was reviewed against; a new recovery decision may match none of its landmarks.
const REVIEWED_SCANNER = "1c5a7ef122d6420e4cdd3e3ce317ee430241f60455b4093088efba7ff253ab62";

// Fail for any other scanner or a moved landmark: the ablation must be reviewed again when the scanner changes.
function disableRecovery(source) {
  if (hash(source.replaceAll("\r\n", "\n")) !== REVIEWED_SCANNER) {
    throw new Error(
      "src/scanner.c differs from the reviewed scanner; review disableRecovery, then update REVIEWED_SCANNER."
    );
  }
  const replace = (pattern, replacement) => {
    if (!pattern.test(source)) throw new Error(`Scanner recovery ablation no longer matches ${pattern}`);
    source = source.replace(pattern, replacement);
  };
  for (const name of [
    "scan_unfinished_variable",
    "tail_start",
    "declaration_name_follows",
    "damaged_declaration_rest",
    "header_ends_early",
    "scan_unfinished_header",
    "statement_ends_before",
    "group_line_rest"
  ]) {
    replace(new RegExp(`static bool ${name}\\([^;{]*\\) \\{`), "$&\n  return false;");
  }
  replace(/valid_symbols\[STATEMENT_BREAK\] && valid_symbols\[STATEMENT_COMMENT_START\]/g, "false");
  replace(/bool is_value_state = [^;]+;/, "bool is_value_state = false;");
  replace(/bool is_inside_statement = [^;]+;/, "bool is_inside_statement = false;");
  replace(/LineEnd line_end = [^;]+;/, "LineEnd line_end = NO_LINE_END;");
  replace(/bool is_at_rule_line = [^;]+;/, "bool is_at_rule_line = false;");
  replace(
    /  if \(\(is_value_state \|\| is_url \|\| is_inside_statement\) && css_space\(lexer->lookahead\)\) lexer->mark_end\(lexer\);/,
    ""
  );
  replace(/if \(valid_symbols\[INCOMPLETE_VARIABLE_PREFIX\]/, "if (false && valid_symbols[INCOMPLETE_VARIABLE_PREFIX]");
  return source;
}

const median = values => values.toSorted((a, b) => a - b)[Math.floor(values.length / 2)];
const change = (before, after) => (after / before - 1) * 100;

function measure({ repo, corpus, rounds = 7, repetitions = 25 }) {
  if (!Number.isSafeInteger(rounds) || rounds < 3 || rounds > 101)
    throw new Error("--rounds must be between 3 and 101.");
  if (!Number.isSafeInteger(repetitions) || repetitions < 1 || repetitions > 10000)
    throw new Error("--repetitions must be between 1 and 10000.");
  const root = resolve(repo || join(__dirname, ".."));
  const local = createRequire(join(root, "package.json"));
  const runtime = join(dirname(local.resolve("tree-sitter/package.json")), "vendor/tree-sitter/lib");
  const directory = mkdtempSync(join(tmpdir(), "scss-recovery-cost-"));
  const compiler = process.env.CC || "cc";
  const run = (command, args) =>
    execFileSync(command, args, { encoding: "utf8", timeout: 120_000, maxBuffer: 16 * 1024 * 1024 });
  try {
    const scanner = readFileSync(join(root, "src/scanner.c"), "utf8");
    const disabled = disableRecovery(scanner);
    cpSync(join(root, "src"), join(directory, "src"), { recursive: true });
    cpSync(join(__dirname, "parser-cost.c"), join(directory, "host.c"));
    writeFileSync(join(directory, "disabled.c"), disabled);
    const flags = [
      "-std=c11",
      "-O2",
      "-D_POSIX_C_SOURCE=200809L",
      // glibc declares the runtime's le16toh and be16toh only with _DEFAULT_SOURCE.
      "-D_DEFAULT_SOURCE",
      "-D_DARWIN_C_SOURCE",
      `-I${join(runtime, "include")}`,
      `-I${join(runtime, "src")}`,
      `-I${join(directory, "src")}`
    ];
    const objects = [];
    for (const [name, source] of [
      ["runtime", join(runtime, "src/lib.c")],
      ["parser", join(directory, "src/parser.c")],
      ["host", join(directory, "host.c")]
    ]) {
      const object = join(directory, `${name}.o`);
      run(compiler, [...flags, "-c", source, "-o", object]);
      objects.push(object);
    }
    const binaries = {};
    for (const [name, source] of [
      ["disabled", join(directory, "disabled.c")],
      ["enabled", join(directory, "src/scanner.c")]
    ]) {
      binaries[name] = join(directory, name);
      // Linking the scanner last keeps the runtime and parser at the same addresses in both executables.
      run(compiler, [...flags, ...objects, source, "-o", binaries[name]]);
    }
    const rules = (count, nested) =>
      Array.from(
        { length: count },
        (_, i) => `.r${i} { width: ${i}px;${nested ? " &:hover { color: blue; }" : ""} }`
      ).join("\n");
    const sources = [
      ["stress", readFileSync(join(root, "examples/highlight-stress.scss"), "utf8")],
      ["flat", rules(1000, false)],
      ["nested", rules(1000, true)],
      ["dense-selectors", rules(20000, true)],
      ...(corpus
        ? readFileSync(corpus, "utf8")
            .split(/\r?\n/)
            .filter(Boolean)
            .map(path => [path, readFileSync(path, "utf8")])
        : [])
    ];
    const results = [];
    for (const [index, [name, text]] of sources.entries()) {
      const file = join(directory, `input-${index}.scss`);
      writeFileSync(file, text);
      for (const dialect of ["scss", "css"]) {
        const memory = Object.fromEntries(
          Object.entries(binaries).map(([variant, binary]) => [
            variant,
            JSON.parse(run(binary, [dialect, file, "1", "memory"]))
          ])
        );
        if (memory.enabled.hasError) {
          results.push({
            name,
            dialect,
            bytes: Buffer.byteLength(text),
            hash: hash(text),
            isComparable: false,
            reason: "Input has errors with recovery enabled.",
            memory
          });
          continue;
        }
        if (memory.disabled.hasError || memory.enabled.shape !== memory.disabled.shape) {
          throw new Error(`${dialect} ${name}: recovery ablation changes complete-input behavior.`);
        }
        const samples = { disabled: [], enabled: [] };
        for (let round = 0; round < rounds; round++) {
          for (const variant of round % 2 ? ["enabled", "disabled"] : ["disabled", "enabled"]) {
            samples[variant].push(JSON.parse(run(binaries[variant], [dialect, file, String(repetitions), "time"])));
          }
        }
        const parsePercent = change(
          median(samples.disabled.map(sample => sample.medianMs)),
          median(samples.enabled.map(sample => sample.medianMs))
        );
        results.push({
          name,
          dialect,
          isComparable: true,
          bytes: Buffer.byteLength(text),
          hash: hash(text),
          parsePercent,
          treePercent: change(memory.disabled.treeBytes, memory.enabled.treeBytes),
          memory,
          samples
        });
      }
    }
    return {
      scope: "Scanner recovery disabled; generated grammar recovery states and tolerances retained.",
      node: process.version,
      platform: `${process.platform}-${process.arch}`,
      cpu: cpus()[0]?.model,
      compiler: run(compiler, ["--version"]).split("\n")[0],
      flags,
      rounds,
      repetitions,
      runtime: local("tree-sitter/package.json").version,
      runtimeHash: sourceHash(runtime),
      parserHash: hash(readFileSync(join(directory, "src/parser.c"))),
      hostHash: hash(readFileSync(join(directory, "host.c"))),
      ablationHash: hash(disableRecovery.toString()),
      scannerHash: hash(scanner),
      disabledScannerHash: hash(disabled),
      results
    };
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

if (require.main === module) {
  try {
    const { values } = parseArgs({
      options: Object.fromEntries(["repo", "corpus", "rounds", "repetitions"].map(name => [name, { type: "string" }]))
    });
    console.log(
      JSON.stringify(
        measure({
          ...values,
          rounds: values.rounds === undefined ? undefined : Number(values.rounds),
          repetitions: values.repetitions === undefined ? undefined : Number(values.repetitions)
        }),
        null,
        2
      )
    );
  } catch (error) {
    console.error(error.stderr?.toString() || error.message);
    process.exitCode = 1;
  }
}

module.exports = { disableRecovery, measure };
