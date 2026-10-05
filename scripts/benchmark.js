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
  "spaced-pseudos": ["a" + " :b".repeat(20000) + " { color: red; } .after {}"],
  "multiline-pseudos": ["a" + "\n:b".repeat(20000) + " { color: red; } .after {}"],
  "long-comment-lines": ["a" + "\n:b".repeat(128) + "\n/*" + "x".repeat(1 << 20) + "*/ { color: red; } .after {}"],
  "interpolated-values": [".a {\n" + `  p: x\n  q: #{${"a".repeat(900)}};\n`.repeat(500) + "}\n.after {}"]
};
const typedStatements = [
  ".b { color: blue; }",
  ".b, .c { color: blue; }",
  ".b > .c:hover { color: blue; }",
  "&:is(.c, .d) { color: blue; }",
  "&-x { color: blue; }",
  '[data-x="a"] { color: blue; }',
  "a:nth-child(2n + 1) { color: blue; }",
  "color: blue;",
  "margin: 1px + 2px;",
  "width: calc(1px + 2px);",
  "$x: (a: 1, b: 2);",
  "--x: 1px;",
  "background: url(a.png);",
  'content: "a #{$b} c";',
  "width: #{$a}px;",
  ".b-#{$x} { color: blue; }",
  "@include m(1, $a: 2);",
  "@extend .x;",
  "@media (min-width: 1px) { color: blue; }",
  "@if $a == 1 { color: blue; } @else { color: red; }",
  "@each $x in (a, b) { color: blue; }",
  "/* note #{$a} */",
  "// note",
  "m10",
  "transition: color .2s ease, width .2s;",
  "> .c { color: blue; }",
  "+ .c { color: blue; }",
  '&[data-state="open"] { color: blue; }',
  "#{$sel} { color: blue; }"
];
// Typing an opener also inserts its closer, and typing that closer over it only moves the caret, as editors pair them.
const electricPairs = { "{": "}", "(": ")", "[": "]", '"': '"' };
const typingRules = name =>
  Array.from(
    { length: 500 },
    (_, index) => `.${name}${index} {\n  margin: ${index}px;\n  &:hover { color: red; }\n}\n`
  ).join("");
// Text before and after the caret: a blank line above `width: 1px;`, or the start of that declaration's own line.
const typingTemplates = {
  "typing-blank": [`${typingRules("h")}.a {\n  color: red;\n  `, `\n  width: 1px;\n}\n${typingRules("t")}`],
  "typing-same-line": [`${typingRules("h")}.a {\n  color: red;\n  `, `width: 1px;\n}\n${typingRules("t")}`]
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

// Native finalizers free trees only after GC and a return to the event loop; callers keep this outside timing.
async function cleanUpSample() {
  globalThis.gc?.();
  await yieldToEventLoop();
}

async function benchmarkDialect(language) {
  const results = [];
  const parser = new Parser();
  parser.setLanguage(language);
  const queryStart = performance.now();
  const query = new Parser.Query(language, Scss.HIGHLIGHTS_QUERY);
  const queryCompileMs = performance.now() - queryStart;
  for (const [name, texts] of Object.entries(sources)) {
    await cleanUpSample();
    const iterations = name === "small" || name === "nested" ? 1000 : 1;
    const samples = { parse: [], highlight: [], total: [] };
    let captures = 0;
    const errorFiles = texts.filter(text => parser.parse(text).rootNode.hasError).length;
    for (let round = 0; round < 11; round++) {
      await cleanUpSample();
      let parseMs = 0;
      let highlightMs = 0;
      captures = 0;
      const start = performance.now();
      for (let index = 0; index < iterations; index++) {
        for (const text of texts) {
          const parseStart = performance.now();
          const tree = parser.parse(text);
          const parsed = performance.now();
          captures += query.captures(tree.rootNode).length;
          highlightMs += performance.now() - parsed;
          parseMs += parsed - parseStart;
        }
      }
      const elapsed = (performance.now() - start) / iterations;
      if (round >= 2) {
        samples.parse.push(parseMs / iterations);
        samples.highlight.push(highlightMs / iterations);
        samples.total.push(elapsed);
      }
    }
    results.push({
      workload: name,
      errorFiles,
      captures: captures / iterations,
      ...Object.fromEntries(Object.entries(samples).map(([phase, times]) => [phase, distribution(times)]))
    });
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
  results.push({ workload: "edit-large", parse: distribution(samples) });
  for (const [workload, template] of Object.entries(typingTemplates)) {
    results.push({ workload, ...(await benchmarkTyping(parser, template)) });
  }
  return { dialect: language.name, queryCompileMs, results };
}

// Each statement is typed key by key into a fresh parse of the template; the counters are deterministic, unlike timing.
async function benchmarkTyping(parser, [before, after]) {
  const samples = [];
  let changedBytes = 0;
  let keysChangingQuarterFile = 0;
  let errorKeys = 0;
  for (const statement of typedStatements) {
    let text = before + after;
    let tree = parser.parse(text);
    for (let offset = 0; offset < statement.length; offset++) {
      const index = before.length + offset;
      const typed = statement[offset];
      if (text[index] === typed && Object.values(electricPairs).includes(typed)) continue;
      const inserted = typed + (electricPairs[typed] ?? "");
      const prefix = text.slice(0, index);
      const position = { row: prefix.split("\n").length - 1, column: index - prefix.lastIndexOf("\n") - 1 };
      text = prefix + inserted + text.slice(index);
      tree.edit({
        startIndex: index,
        oldEndIndex: index,
        newEndIndex: index + inserted.length,
        startPosition: position,
        oldEndPosition: position,
        newEndPosition: { row: position.row, column: position.column + inserted.length }
      });
      await cleanUpSample();
      const start = performance.now();
      const next = parser.parse(text, tree);
      samples.push(performance.now() - start);
      const changed = tree.getChangedRanges(next).reduce((size, range) => size + range.endIndex - range.startIndex, 0);
      changedBytes += changed;
      if (changed > text.length / 4) keysChangingQuarterFile++;
      if (next.rootNode.hasError) errorKeys++;
      tree = next;
    }
  }
  return {
    parse: distribution(samples),
    keys: samples.length,
    changedKB: Math.round(changedBytes / 1024),
    keysChangingQuarterFile,
    errorKeys
  };
}

async function main() {
  const results = [];
  for (const language of [Scss, Scss.cssLanguage]) {
    results.push(await benchmarkDialect(language));
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
        loadMs,
        maxRssKiB,
        processRssAfterCleanupBytes,
        nativeBytes: statSync(local("node-gyp-build").path(root)).size,
        parserBytes: generated.length,
        parserHash: hash(generated),
        scannerHash: hash(readFileSync(join(root, "src/scanner.c"))),
        states: Number(generated.toString().match(/^#define STATE_COUNT (\d+)$/m)[1]),
        largeStates: Number(generated.toString().match(/^#define LARGE_STATE_COUNT (\d+)$/m)[1]),
        queryHash: hash(Scss.HIGHLIGHTS_QUERY),
        workloads: Object.fromEntries([
          ...Object.entries(sources).map(([name, texts]) => [
            name,
            {
              files: texts.length,
              bytes: texts.reduce((size, text) => size + Buffer.byteLength(text), 0),
              hash: hash(JSON.stringify(texts))
            }
          ]),
          // The typed keys are as much a typing workload's input as the file they are typed into.
          ...Object.entries(typingTemplates).map(([name, template]) => [
            name,
            {
              files: 1,
              bytes: Buffer.byteLength(template.join("")),
              hash: hash(JSON.stringify([template, typedStatements, electricPairs]))
            }
          ])
        ]),
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
