// Run each revision in a fresh process after building its own native binding.
const { Buffer } = require("node:buffer");
const { createHash } = require("node:crypto");
const { readFileSync, statSync } = require("node:fs");
const { createRequire } = require("node:module");
const { join, resolve } = require("node:path");
const { performance } = require("node:perf_hooks");
const { setImmediate: yieldToEventLoop } = require("node:timers/promises");
const { parseArgs } = require("node:util");

const { values } = parseArgs({ options: { repo: { type: "string" }, corpus: { type: "string" } } });
const root = resolve(values.repo || join(__dirname, ".."));
const local = createRequire(join(root, "package.json"));
const loadStart = performance.now();
const Parser = local("tree-sitter");
const Scss = local("./bindings/node");
const loadMs = performance.now() - loadStart;
const hash = text => createHash("sha256").update(text).digest("hex");
const rules = count =>
  Array.from({ length: count }, (_, index) => `.r${index} { width: ${index}px; &:hover { color: blue; } }`).join("\n");
const sources = {
  small: [".a { color: red; width: calc(1px + 2px); }"],
  stress: [readFileSync(join(root, "examples/highlight-stress.scss"), "utf8")],
  medium: [rules(100)],
  large: [rules(1000)],
  nested: ['.a { content: "' + '#{ "'.repeat(12) + "x" + '" }'.repeat(12) + '"; }'],
  unmatched: ['.a { content: "' + "#{ x ".repeat(10000) + '"; } .after {}'],
  "spaced-pseudos": ["a" + " :b".repeat(20000) + " { color: red; } .after {}"],
  "multiline-pseudos": ["a" + "\n:b".repeat(20000) + " { color: red; } .after {}"]
};
if (values.corpus) {
  sources.corpus = readFileSync(values.corpus, "utf8")
    .trim()
    .split(/\r?\n/)
    .filter(Boolean)
    .map(file => readFileSync(file, "utf8"));
}

function distribution(samples) {
  const sorted = samples.toSorted((a, b) => a - b);
  return { p50Ms: sorted[Math.floor(sorted.length / 2)], p95Ms: sorted[Math.floor(sorted.length * 0.95)] };
}

// Native Tree finalizers run after V8 collection, when Node returns to the event loop.
// Keep both steps outside timed regions, including incremental samples.
async function cleanUpSample() {
  globalThis.gc?.();
  await yieldToEventLoop();
}

async function benchmarkDialect(language) {
  const results = [];
  const parser = new Parser();
  parser.setLanguage(language);
  for (const [name, texts] of Object.entries(sources)) {
    const iterations = name === "small" || name === "nested" ? 1000 : 1;
    const samples = [];
    for (let round = 0; round < 11; round++) {
      await cleanUpSample();
      const start = performance.now();
      for (let index = 0; index < iterations; index++) {
        for (const text of texts) parser.parse(text);
      }
      const elapsed = (performance.now() - start) / iterations;
      if (round >= 2) samples.push(elapsed);
    }
    results.push({ dialect: language.name, workload: name, ...distribution(samples) });
  }

  let text = sources.large[0];
  let tree = parser.parse(text);
  const index = text.indexOf("500px");
  const row = text.slice(0, index).split("\n").length - 1;
  const column = index - text.lastIndexOf("\n", index) - 1;
  const samples = [];
  for (let iteration = 0; iteration < 220; iteration++) {
    await cleanUpSample();
    text = text.slice(0, index) + (iteration % 2 ? "500" : "501") + text.slice(index + 3);
    tree.edit({
      startIndex: index,
      oldEndIndex: index + 3,
      newEndIndex: index + 3,
      startPosition: { row, column },
      oldEndPosition: { row, column: column + 3 },
      newEndPosition: { row, column: column + 3 }
    });
    const start = performance.now();
    tree = parser.parse(text, tree);
    if (iteration >= 20) samples.push(performance.now() - start);
  }
  results.push({ dialect: language.name, workload: "edit-large", ...distribution(samples) });
  return results;
}

async function main() {
  const results = [];
  for (const language of [Scss, Scss.cssLanguage]) {
    results.push(...(await benchmarkDialect(language)));
    // The dialect scope releases its final tree and parser before the next dialect.
    await cleanUpSample();
  }
  const maxRssKiB = process.resourceUsage().maxRSS;
  const processRssAfterCleanupBytes = process.memoryUsage().rss;

  const generated = readFileSync(join(root, "src/parser.c"));
  console.log(
    JSON.stringify(
      {
        node: process.version,
        runtime: local("tree-sitter/package.json").version,
        platform: `${process.platform}-${process.arch}`,
        gcBetweenParseSamples: typeof globalThis.gc === "function",
        sampleCleanup: { forcedGc: typeof globalThis.gc === "function", eventLoopYield: true },
        loadMs,
        maxRssKiB,
        processRssAfterCleanupBytes,
        nativeBytes: statSync(local("node-gyp-build").path(root)).size,
        parserBytes: generated.length,
        parserHash: hash(generated),
        scannerHash: hash(readFileSync(join(root, "src/scanner.c"))),
        states: Number(generated.toString().match(/^#define STATE_COUNT (\d+)$/m)[1]),
        largeStates: Number(generated.toString().match(/^#define LARGE_STATE_COUNT (\d+)$/m)[1]),
        workloads: Object.fromEntries(
          Object.entries(sources).map(([name, texts]) => [
            name,
            {
              files: texts.length,
              bytes: texts.reduce((size, text) => size + Buffer.byteLength(text), 0),
              hash: hash(JSON.stringify(texts))
            }
          ])
        ),
        results
      },
      null,
      2
    )
  );
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
