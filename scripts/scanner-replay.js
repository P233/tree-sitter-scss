const { Buffer } = require("node:buffer");
const { execFileSync, spawnSync } = require("node:child_process");
const { createHash } = require("node:crypto");
const {
  closeSync,
  cpSync,
  mkdtempSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
  writeSync
} = require("node:fs");
const { createRequire } = require("node:module");
const { cpus, tmpdir } = require("node:os");
const { dirname, join, resolve } = require("node:path");
const { parseArgs } = require("node:util");
const { performance } = require("node:perf_hooks");
const { repositoryInputs } = require("./fuzz.js");
const { validInputs } = require("./valid-inputs.js");
const fixtures = require("./recovery-fixtures.js");

const hash = source => createHash("sha256").update(source).digest("hex");
const root = join(__dirname, "..");

function externalSets(source) {
  const tokens = [...source.matchAll(/^\s*(ts_external_token_\w+)\s*=\s*(\d+),/gm)].map(([, name, index]) => ({
    name,
    index: Number(index)
  }));
  const table = source.match(/ts_external_scanner_states\[(\d+)\]\[EXTERNAL_TOKEN_COUNT\]\s*=\s*\{([\s\S]*?)^\};/m);
  if (!tokens.length || !table) throw new Error("src/parser.c: external token enum or scanner states are missing.");
  if (tokens.some((token, index) => token.index !== index))
    throw new Error("src/parser.c: external token enum is not contiguous.");
  const sets = Array.from({ length: Number(table[1]) }, () => []);
  for (const [, index, body] of table[2].matchAll(/\[(\d+)\]\s*=\s*\{([^}]+)\}/g)) {
    if (!sets[Number(index)]) throw new Error("src/parser.c: external set index is out of range.");
    sets[Number(index)] = [...body.matchAll(/\[(ts_external_token_\w+)\]\s*=\s*true/g)].map(match => match[1]).sort();
  }
  if (sets[0].length || sets.slice(1).some(set => !set.length))
    throw new Error("src/parser.c: expected an empty set 0 and nonempty subsequent external sets.");
  if (sets.flat().some(name => !tokens.some(token => token.name === name)))
    throw new Error("src/parser.c: unknown external token in scanner states.");
  return { tokens: tokens.map(token => token.name), sets };
}

function assertSameSets(base, candidate) {
  if (JSON.stringify(base) !== JSON.stringify(candidate)) {
    throw new Error(
      "External scanner sets differ; a grammar change is not an equivalence refactor. Compare the generated tables first."
    );
  }
}

function recoveryInputs() {
  const inputs = [];
  const add = (id, text) => inputs.push({ id: "recovery/" + id, text });
  for (const [category, statements] of Object.entries(fixtures.contractStatements)) {
    for (const [layout, [before, after]] of Object.entries(fixtures.contractLayouts)) {
      for (const [index, statement] of statements.entries()) {
        add(["contract", category, layout, index].join("/"), fixtures.contractBefore + before + statement + after);
      }
    }
  }
  const statements = [
    ...Object.values(fixtures.contractStatements).flat(),
    ...fixtures.typingStatements,
    ...fixtures.blockStatements,
    ...fixtures.headers,
    ...fixtures.unfinishedHeaders
  ];
  for (const [index, statement] of statements.entries()) {
    for (const [layout, [before, after]] of Object.entries(fixtures.contractLayouts)) {
      for (const mode of ["plain", "paired"]) {
        const pairs = mode === "plain" ? {} : { "(": ")", "[": "]", "{": "}", '"': '"' };
        let key = 0;
        for (const { text } of fixtures.typingStates(before, after, statement, pairs, true)) {
          add(["prefix", index, layout, mode, ++key].join("/"), text);
        }
      }
    }
  }
  for (const [category, lines] of Object.entries(fixtures.unfinishedLines)) {
    for (const [index, line] of lines.entries()) {
      for (const [headerIndex, header] of fixtures.unfinishedHeaders.entries()) {
        for (const gap of ["\n  ", " "]) {
          add(
            ["unfinished", category, index, headerIndex, gap.length].join("/"),
            ".a {\n  " + line + gap + header + "\n}\n.after {}"
          );
        }
      }
    }
  }
  for (const [name, text] of Object.entries(fixtures.typos)) add("typo/" + name, text + "\n.after {}");
  return inputs;
}

function replayInputs(corpus) {
  const inputs = [
    ...repositoryInputs(),
    ...validInputs(),
    ...recoveryInputs(),
    ...(corpus
      ? readFileSync(corpus, "utf8")
          .split(/\r?\n/)
          .filter(Boolean)
          .map(file => ({ id: file, text: readFileSync(file) }))
      : [])
  ];
  const seen = new Set();
  return inputs.filter(input => {
    input.bytes = Buffer.isBuffer(input.text) ? input.text : Buffer.from(input.text);
    const fingerprint = hash(input.bytes);
    if (seen.has(fingerprint)) return false;
    seen.add(fingerprint);
    input.hash = fingerprint;
    return true;
  });
}

function sourceHash(directory) {
  return hash(
    readdirSync(directory, { recursive: true })
      .filter(path => /\.[ch]$/.test(path))
      .sort()
      .map(path => path + "\0" + hash(readFileSync(join(directory, path))) + "\n")
      .join("")
  );
}

function replay({ repo, base, baseDir, corpus, inputs: suppliedInputs }) {
  if (base !== undefined && baseDir !== undefined)
    throw new Error("Use either --base <revision> or --base-dir <directory>.");
  base ??= "HEAD";
  const started = performance.now();
  const candidate = resolve(repo || root);
  const local = createRequire(join(candidate, "package.json"));
  const runtime = join(dirname(local.resolve("tree-sitter/package.json")), "vendor/tree-sitter/lib");
  const directory = mkdtempSync(join(tmpdir(), "scss-scanner-replay-"));
  const compiler = process.env.CC || "cc";
  const run = (command, args) =>
    execFileSync(command, args, { encoding: "utf8", timeout: 120_000, maxBuffer: 16 * 1024 * 1024 });
  try {
    const paths = { base: join(directory, "base"), candidate: join(directory, "candidate") };
    for (const [variant, path] of Object.entries(paths)) {
      mkdirSync(path);
      const source = variant === "candidate" ? candidate : baseDir === undefined ? null : resolve(baseDir);
      if (source) cpSync(join(source, "src"), join(path, "src"), { recursive: true });
      else {
        const revision = run("git", [
          "-C",
          candidate,
          "rev-parse",
          "--verify",
          "--end-of-options",
          base + "^{commit}"
        ]).trim();
        const files = run("git", ["-C", candidate, "ls-tree", "-r", "--name-only", revision, "--", "src"])
          .trim()
          .split("\n")
          .filter(file => /\.[ch]$/.test(file));
        for (const file of files) {
          mkdirSync(dirname(join(path, file)), { recursive: true });
          writeFileSync(join(path, file), run("git", ["-C", candidate, "show", revision + ":" + file]));
        }
      }
    }
    const tables = Object.fromEntries(
      Object.entries(paths).map(([variant, path]) => [
        variant,
        externalSets(readFileSync(join(path, "src/parser.c"), "utf8"))
      ])
    );
    assertSameSets(tables.base, tables.candidate);
    const inputs = suppliedInputs || replayInputs(corpus);
    const packed = join(directory, "inputs");
    const fd = openSync(packed, "w");
    try {
      for (const input of inputs) {
        writeSync(fd, Buffer.from(new Uint32Array([input.bytes.length]).buffer));
        writeSync(fd, input.bytes);
      }
    } finally {
      closeSync(fd);
    }
    const flags = ["-std=c11", "-O2", "-D_DEFAULT_SOURCE", "-D_DARWIN_C_SOURCE", "-I" + join(runtime, "src")];
    const host = join(__dirname, "scanner-replay.c");
    const objects = [];
    const buildStarted = performance.now();
    for (const [variant, path] of Object.entries(paths)) {
      const renames = [
        "tree_sitter_scss",
        "tree_sitter_stylesheet_css",
        ...["create", "destroy", "serialize", "deserialize", "scan"].map(
          name => "tree_sitter_scss_external_scanner_" + name
        )
      ].map(name => "-D" + name + "=" + variant + "_" + name);
      for (const [name, source] of [
        ["host", host],
        ["scanner", join(path, "src/scanner.c")]
      ]) {
        const object = join(path, name + ".o");
        run(compiler, [
          "-I" + join(path, "src"),
          ...flags,
          ...renames,
          "-DPROBE=" + variant + "_probe",
          "-c",
          source,
          "-o",
          object
        ]);
        objects.push(object);
      }
    }
    const binary = join(directory, "replay");
    run(compiler, [...flags, "-I" + join(paths.candidate, "src"), "-DREPLAY_DRIVER", host, ...objects, "-o", binary]);
    const buildSeconds = (performance.now() - buildStarted) / 1000;
    const measured = performance.now();
    const result = spawnSync(binary, [packed, String(tables.candidate.sets.length)], {
      encoding: "utf8",
      timeout: 600_000,
      maxBuffer: 16 * 1024 * 1024
    });
    const replaySeconds = (performance.now() - measured) / 1000;
    if (result.error) throw result.error;
    if (result.status !== 0 && result.status !== 1)
      throw new Error("Scanner replay failed (" + (result.signal || "exit " + result.status) + "): " + result.stderr);
    const records = result.stdout
      .trim()
      .split("\n")
      .map(line => JSON.parse(line));
    const summary = records.pop();
    const expectedCalls = inputs.reduce(
      (total, input) => total + (input.bytes.length + 1) * tables.candidate.sets.length * 4,
      0
    );
    if (summary.inputs !== inputs.length || summary.calls !== expectedCalls || summary.differences === undefined)
      throw new Error("Incomplete scanner replay output.");
    const differences = records.map(record => {
      const input = inputs[record.input];
      return {
        ...record,
        input: input.id,
        context: input.bytes.subarray(Math.max(0, record.offset - 32), record.offset + 64).toString("utf8"),
        symbols: { base: tables.base.tokens[record.base[1]], candidate: tables.candidate.tokens[record.candidate[1]] },
        valid: record.set === tables.candidate.sets.length ? "all-valid" : tables.candidate.sets[record.set]
      };
    });
    return {
      scope:
        "Every byte offset including EOF, nonempty external sets plus all-valid, both dialects and included-range-start flags; direct comparison of every result.",
      resultFields: ["return", "symbol", "markEnd", "position", "advances", "usedColumn"],
      unsetMarkEnd: 0xffffffff,
      node: process.version,
      platform: process.platform + "-" + process.arch,
      cpu: cpus()[0]?.model,
      compiler: run(compiler, ["--version"]).split("\n")[0],
      compilerHash: hash(readFileSync(run("which", [compiler]).trim())),
      flags,
      runtime: local("tree-sitter/package.json").version,
      runtimeHash: sourceHash(runtime),
      hostHash: hash(readFileSync(host)),
      base: baseDir === undefined ? { revision: base } : { directory: resolve(baseDir) },
      sources: Object.fromEntries(
        Object.entries(paths).map(([variant, path]) => [
          variant,
          {
            parser: hash(readFileSync(join(path, "src/parser.c"))),
            scanner: hash(readFileSync(join(path, "src/scanner.c"))),
            headers: sourceHash(join(path, "src/tree_sitter"))
          }
        ])
      ),
      inputs: inputs.map(input => ({ id: input.id, bytes: input.bytes.length, hash: input.hash })),
      inputHash: hash(inputs.map(input => input.hash + "\n").join("")),
      externalSets: tables.candidate,
      buildSeconds,
      replaySeconds,
      seconds: (performance.now() - started) / 1000,
      summary,
      differences
    };
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

function formatReplay(result) {
  const { summary, sources } = result;
  const lines = [
    `Scanner replay: ${summary.inputs} inputs, ${summary.calls} calls, ${summary.differences} differences; ` +
      `${result.seconds.toFixed(3)} s (${result.buildSeconds.toFixed(3)} build, ${result.replaySeconds.toFixed(3)} replay).`
  ];
  for (const [variant, hashes] of Object.entries(sources)) {
    lines.push(
      `${variant} source SHA-256: ${Object.entries(hashes)
        .map(([name, hash]) => `${name}=${hash}`)
        .join(" ")}`
    );
  }
  lines.push(
    `Compiler: ${result.compiler}; SHA-256 ${result.compilerHash}`,
    `Tree-sitter: ${result.runtime}; SHA-256 ${result.runtimeHash}`,
    `Harness SHA-256: ${result.hostHash}; inputs SHA-256: ${result.inputHash}`
  );
  for (const difference of result.differences) {
    lines.push(
      `Difference: input=${JSON.stringify(difference.input)} offset=${difference.offset} set=${difference.set} ` +
        `dialect=${difference.dialect} includedRangeStart=${difference.includedRangeStart}`,
      `  valid: ${Array.isArray(difference.valid) ? difference.valid.join(", ") : difference.valid}`
    );
    for (const variant of ["base", "candidate"]) {
      const tuple = difference[variant].map((value, index) => {
        const field = result.resultFields[index];
        if (field === "symbol") return `${field}=${difference.symbols[variant] ?? "unknown"} (${value})`;
        if (field === "markEnd" && value === result.unsetMarkEnd) return `${field}=unset`;
        return `${field}=${field === "return" || field === "usedColumn" ? Boolean(value) : value}`;
      });
      lines.push(`  ${variant}: ${tuple.join(", ")}`);
    }
    lines.push(`  context: ${JSON.stringify(difference.context)}`);
  }
  return lines.join("\n");
}

if (require.main === module) {
  try {
    const { values } = parseArgs({
      options: Object.fromEntries(
        ["repo", "base", "base-dir", "corpus", "json"].map(name => [name, { type: "string" }])
      )
    });
    const result = replay({ ...values, baseDir: values["base-dir"] });
    if (values.json) writeFileSync(resolve(values.json), JSON.stringify(result, null, 2) + "\n");
    console.log(formatReplay(result));
    if (result.summary.differences) process.exitCode = 1;
  } catch (error) {
    console.error(error.stderr?.toString() || error.message);
    process.exitCode = 1;
  }
}

module.exports = { externalSets, assertSameSets, recoveryInputs, replayInputs, replay, formatReplay };
