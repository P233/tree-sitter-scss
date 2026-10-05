const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const { mkdtempSync, readFileSync, rmSync, writeFileSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join } = require("node:path");
const { test } = require("node:test");
const Parser = require("tree-sitter");
const Scss = require("../bindings/node");
const {
  compare,
  corpusInputs,
  createSummary,
  hasCleanFailure,
  nextEdit,
  position,
  recordCases,
  repositoryInputs,
  shape,
  tally
} = require("./fuzz.js");

const languages = [Scss, Scss.cssLanguage];
const NON_ASCII =
  '.a😀 { content: "颜色🧪"; }\r\n/* é → 😀 */ .b { --宽: 1px; width: 2px; }\n.c::before { content: "𝔘" }';

function record(language, inputs, seed, cases) {
  return Array.fromAsync(
    recordCases({ Parser, language, highlightsQuery: Scss.HIGHLIGHTS_QUERY, inputs, seed, cases })
  );
}

function recorded(fields) {
  return {
    dialect: "scss",
    case: 0,
    input: "a.scss",
    inputHash: "0",
    start: 1000,
    del: 0,
    insert: ";",
    hasError: true,
    hasOriginalError: false,
    tree: "base",
    isIncrementalExact: true,
    isRevertExact: true,
    captures: ["property@990-995", "number@1001-1003"],
    ...fields
  };
}

test("the same seed and inputs reproduce identical records", async () => {
  const inputs = [
    { id: "rules", text: ".a { color: red; }\n.b { &:hover { width: 1px; } }\n" },
    { id: "sass", text: "$map: (a: 1, b: 2);\n@mixin m($x) { margin: $x; }\n.c { @include m(2px); }\n" },
    { id: "non-ascii", text: NON_ASCII }
  ];
  const edits = records => records.map(({ input, start, del, insert }) => [input, start, del, insert]);
  for (const language of languages) {
    const first = await record(language, inputs, 11, 60);
    assert.deepEqual(await record(language, inputs, 11, 60), first);
    assert.notDeepEqual(edits(await record(language, inputs, 12, 60)), edits(first));
    assert.ok(first.every(result => result.dialect === language.name));
  }
});

test("recording compares incremental and reverted trees with fresh parses of the same text", async () => {
  // A stand-in parser whose tree is its text, optionally altered whenever it reuses an old tree.
  const parserFor = isReuseBroken => {
    const tree = text => ({
      rootNode: { hasError: false },
      edit() {},
      walk: () => ({
        nodeIsNamed: true,
        nodeType: text,
        startIndex: 0,
        endIndex: text.length,
        gotoFirstChild: () => false,
        gotoNextSibling: () => false,
        gotoParent: () => false
      })
    });
    return class {
      static Query = class {
        captures() {
          return [];
        }
      };
      setLanguage() {}
      parse(text, previous) {
        return tree(previous && isReuseBroken ? `${text}!` : text);
      }
    };
  };
  const inputs = [{ id: "rule", text: ".a { color: red; }" }];
  for (const isReuseBroken of [false, true]) {
    const options = { language: { name: "stub" }, highlightsQuery: "", inputs, seed: 3, cases: 20 };
    const results = await Array.fromAsync(recordCases({ Parser: parserFor(isReuseBroken), ...options }));
    assert.ok(results.some(result => result.del || result.insert));
    for (const result of results) {
      assert.equal(result.isIncrementalExact, !isReuseBroken, JSON.stringify(result));
      assert.equal(result.isRevertExact, !isReuseBroken, JSON.stringify(result));
    }
  }
});

test("edits use the Node binding's positions and keep whole characters", async () => {
  const parser = new Parser();
  parser.setLanguage(Scss);
  const visit = node => {
    assert.deepEqual(position(NON_ASCII, node.startIndex), node.startPosition, node.type);
    assert.deepEqual(position(NON_ASCII, node.endIndex), node.endPosition, node.type);
    node.children.forEach(visit);
  };
  visit(parser.parse(NON_ASCII).rootNode);

  // Draws: input, a start inside the first pair, a deletion ending inside the second pair, no insertion.
  const draws = [0, 2, 0, 4, 0];
  assert.deepEqual(
    nextEdit(() => draws.shift(), [{ text: "a😀b😀c" }]),
    { input: 0, start: 1, del: 3, insert: "" }
  );
  const splitsPair = index => /[\ud800-\udbff][\udc00-\udfff]/.test(NON_ASCII.slice(index - 1, index + 1));
  for (const language of languages) {
    for (const result of await record(language, [{ id: "non-ascii", text: NON_ASCII }], 5, 300)) {
      assert.ok(!splitsPair(result.start) && !splitsPair(result.start + result.del), JSON.stringify(result));
      assert.ok(result.isIncrementalExact && result.isRevertExact, JSON.stringify(result));
    }
  }
});

test("tree identity includes the ranges and tokens that toString() omits", () => {
  const parser = new Parser();
  parser.setLanguage(Scss);
  for (const pair of [
    [".a{}", ".a {}"],
    ["a { b: c; }", "a { b: c }"]
  ]) {
    const [left, right] = pair.map(text => parser.parse(text));
    assert.equal(left.rootNode.toString(), right.rootNode.toString());
    assert.notEqual(shape(left), shape(right), pair.join(" vs "));
  }
});

test("corpus inputs follow the Tree-sitter test format", () => {
  const corpus = [
    "==========",
    "Longest divider",
    ":skip",
    "==========",
    ".a {}",
    "---",
    ".b {}",
    "--- suffixed lines are not dividers",
    "",
    "-----",
    "(stylesheet)",
    "",
    "===",
    "CRLF input",
    "===",
    "a {}\r",
    "---\r",
    "(stylesheet)",
    "",
    "===",
    "Last of equal dividers",
    "===",
    ".c {}",
    "---",
    ".d {}",
    "---",
    "(stylesheet)",
    ""
  ].join("\n");
  assert.deepEqual(corpusInputs(corpus, "x.txt"), [
    { id: "x.txt:5", text: ".a {}\n---\n.b {}\n--- suffixed lines are not dividers\n" },
    { id: "x.txt:16", text: "a {}" },
    { id: "x.txt:23", text: ".c {}\n---\n.d {}" }
  ]);
  const suffixed = ["===|||", "Suffixed", "===|||", "a {}", "===", "Not a header", "===", "---|||", "(x)", ""];
  assert.deepEqual(corpusInputs(suffixed.join("\n"), "y.txt"), [
    { id: "y.txt:4", text: "a {}\n===\nNot a header\n===" }
  ]);
  // Names may start with "=" or be empty, and blank lines may follow an attribute but not precede one.
  const headerForms = [
    "===",
    "== operator",
    "===",
    "a == b",
    "---",
    "(x)",
    "",
    "===",
    "Attributes",
    ":skip",
    "",
    ":fail-fast",
    "===",
    ".e {}",
    "---",
    "(x)",
    "",
    "===",
    "===",
    ".f {}",
    "===",
    "",
    "===",
    "---",
    "(x)",
    ""
  ];
  assert.deepEqual(corpusInputs(headerForms.join("\n"), "z.txt"), [
    { id: "z.txt:4", text: "a == b" },
    { id: "z.txt:14", text: ".e {}" },
    { id: "z.txt:20", text: ".f {}\n===\n\n===" }
  ]);

  const inputs = repositoryInputs();
  for (const name of ["basics", "corners", "extended"]) {
    const path = `test/corpus/${name}.txt`;
    const headers = readFileSync(join(__dirname, "..", path), "utf8").match(/^=+$/gm).length / 2;
    assert.equal(inputs.filter(input => input.id.startsWith(`${path}:`)).length, headers, path);
  }
  assert.equal(inputs.find(input => input.id === "test/corpus/basics.txt:4").text, "body { color: red; }");
  assert.ok(inputs.some(input => input.id === "examples/highlight-stress.scss"));
});

test("comparison separates clean, local and remote differences", async () => {
  const base = [
    recorded({ case: 0, hasError: false }),
    recorded({ case: 1 }),
    recorded({ case: 2, captures: ["tag@690-700", "tag@1301-1305"] }),
    recorded({ case: 3, captures: ["tag@690-699", "tag@1302-1305"] }),
    recorded({ case: 4 }),
    recorded({ case: 5 }),
    recorded({ case: 6, hasError: false, captures: ["tag@1400-1404"] }),
    recorded({ case: 7, hasError: false })
  ];
  const candidate = [
    recorded({ case: 0, tree: "changed" }),
    recorded({ case: 1, tree: "changed", captures: ["property@990-995"] }),
    recorded({ case: 2, tree: "changed", captures: [] }),
    recorded({ case: 3, tree: "changed", captures: [] }),
    recorded({ case: 4, tree: "changed", captures: [...base[4].captures, "tag@2000-2004"] }),
    recorded({ case: 5, captures: ["type@990-995"], isIncrementalExact: false }),
    recorded({ case: 6, tree: "changed", captures: ["tag@2000-2004"] }),
    recorded({ case: 7, tree: "changed", captures: ["number@1001-1003"] })
  ];
  const report = await compare(base, candidate);
  assert.deepEqual(Object.fromEntries(Object.entries(report).filter(([, value]) => typeof value === "number")), {
    cases: 8,
    cleanDiff: 3,
    errTreeDiff: 4,
    lossCases: 3,
    lostCaps: 5,
    gainCases: 1,
    gainedCaps: 1,
    remoteLossCases: 1,
    remoteLostCaps: 2,
    remoteGainCases: 1,
    remoteGainedCaps: 1,
    localOnlyLossCases: 2,
    captureOnlyDiff: 1
  });
  assert.equal(report.remoteLossCases + report.localOnlyLossCases, report.lossCases);
  assert.deepEqual(report.candidate.dialects.scss.incrementalMismatches, { clean: 0, error: 1 });
  assert.equal(report.examples.clean.length, 3);
  assert.equal(report.examples.remoteLoss.length, 1);
  assert.match(report.examples.remoteLoss[0], /scss #3 a\.scss at 1000 -0 \+";": lost tag@690-699 tag@1302-1305$/);

  await assert.rejects(compare([base[0]], [recorded({ insert: "{" })]), /not aligned at line 1: insert ";" vs "\{"/);
  await assert.rejects(compare(base.slice(0, 2), candidate.slice(0, 1)), /the candidate ends at line 2/);
  await assert.rejects(compare([], []), /contain no cases/);
});

test("comparison and recording exit statuses follow their acceptance rules", t => {
  const directory = mkdtempSync(join(tmpdir(), "scss-fuzz-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const run = (base, candidate) => {
    const files = Object.entries({ base, candidate }).map(([name, records]) => {
      const file = join(directory, `${name}.jsonl`);
      writeFileSync(file, records.map(result => `${JSON.stringify(result)}\n`).join(""));
      return file;
    });
    return spawnSync(process.execPath, [join(__dirname, "fuzz.js"), "compare", ...files], { encoding: "utf8" });
  };
  const local = recorded({ tree: "changed", captures: ["property@990-995"] });
  assert.equal(run([recorded()], [local]).status, 0);
  assert.equal(run([recorded()], [recorded({ tree: "changed", captures: [] })]).status, 0);
  const remote = run([recorded({ captures: ["tag@1400-1404"] })], [recorded({ tree: "changed", captures: [] })]);
  assert.equal(remote.status, 1, remote.stderr);
  assert.equal(JSON.parse(remote.stdout).remoteLossCases, 1);
  assert.equal(run([recorded({ hasError: false })], [recorded({ tree: "changed" })]).status, 1);
  const misaligned = run([recorded()], [recorded({ start: 1 })]);
  assert.equal(misaligned.status, 2);
  assert.match(misaligned.stderr, /not aligned at line 1: start 1000 vs 1/);
  const foreign = {
    lang: "scss",
    r: 0,
    error: true,
    tree: "1:a",
    incSame: true,
    reverted: true,
    caps: [],
    start: 0,
    del: 0,
    insert: ""
  };
  const unusable = run([foreign], [foreign]);
  assert.equal(unusable.status, 2);
  assert.match(unusable.stderr, /base\.jsonl:1: dialect must be a string\./);
  const malformed = run([recorded()], [recorded({ captures: ["property"] })]);
  assert.equal(malformed.status, 2);
  assert.match(malformed.stderr, /candidate\.jsonl:1: captures must be an array of name@start-end captures\./);

  const out = join(directory, "recording.jsonl");
  const recording = spawnSync(
    process.execPath,
    [join(__dirname, "fuzz.js"), "record", "--seed", "2", "--cases", "3", "--out", out],
    { encoding: "utf8" }
  );
  assert.equal(recording.status, 0, recording.stderr);
  const { dialects } = JSON.parse(recording.stdout);
  assert.deepEqual(Object.keys(dialects), ["scss", "stylesheet-css"]);
  assert.equal(readFileSync(out, "utf8").trim().split("\n").length, 6);
  const itself = spawnSync(process.execPath, [join(__dirname, "fuzz.js"), "compare", out, out], { encoding: "utf8" });
  assert.equal(itself.status, 0, itself.stderr);
  assert.equal(JSON.parse(itself.stdout).cases, 6);

  const summary = createSummary();
  tally(summary, recorded({ isIncrementalExact: false, isRevertExact: false, hasOriginalError: true }));
  assert.equal(hasCleanFailure(summary), false, "error-tree mismatches are reported, not failed");
  tally(summary, recorded({ isRevertExact: false }));
  assert.equal(hasCleanFailure(summary), true, "an error-free original must revert exactly");
  tally(summary, recorded({ hasError: false }));
  assert.equal(summary.dialects.scss.cases, 3);
  assert.equal(summary.dialects.scss.errorTrees, 2);
  const incremental = createSummary();
  tally(incremental, recorded({ hasError: false, isIncrementalExact: false }));
  assert.equal(hasCleanFailure(incremental), true, "an error-free tree must parse incrementally");
  assert.deepEqual(incremental.dialects.scss.incrementalMismatches, { clean: 1, error: 0 });
  assert.match(incremental.examples.clean[0], /^incremental: scss #0 a\.scss/);
});

test("repository inputs keep error-free trees identical across incremental parses", async () => {
  const inputs = repositoryInputs();
  for (const language of languages) {
    const summary = createSummary();
    const results = await record(language, inputs, 1, 150);
    for (const result of results) tally(summary, result);
    assert.equal(summary.dialects[language.name].cases, 150);
    assert.deepEqual(summary.examples.clean, []);
    assert.equal(hasCleanFailure(summary), false);
    assert.ok(results.some(result => result.captures.length > 0 && !result.hasError));
    assert.ok(results.every(result => result.captures.every(capture => /^[\w.-]+@\d+-\d+$/.test(capture))));
    assert.ok(new Set(results.map(result => result.tree)).size > 100, "distinct edits must give distinct trees");
  }
});
