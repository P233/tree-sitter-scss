const assert = require("node:assert/strict");
const { Buffer } = require("node:buffer");
const { readFileSync } = require("node:fs");
const { join } = require("node:path");
const { test } = require("node:test");
const { runInNewContext } = require("node:vm");

for (const forcedGc of [true, false]) {
  test(`benchmark yields between samples outside timing with forced GC ${forcedGc}`, async () => {
    let clock = 0;
    let pendingTrees = 0;
    let peakPendingTrees = 0;
    let editedTrees = 0;
    let collected = false;
    let output;
    const source = readFileSync(join(__dirname, "benchmark.js"), "utf8");
    const scss = { name: "scss", cssLanguage: { name: "css" }, HIGHLIGHTS_QUERY: "test query" };
    const point = (text, index) => {
      const lines = text.slice(0, index).split("\n");
      return { row: lines.length - 1, column: lines.at(-1).length };
    };
    class Parser {
      static Query = class {
        constructor() {
          clock += 7;
        }
        captures() {
          clock += 2;
          return ["tag", "property"];
        }
      };
      setLanguage(language) {
        this.language = language;
      }
      parse(text, oldTree) {
        if (oldTree) {
          assert.equal(pendingTrees, 0, "retired trees must drain before the next edit sample");
          assert.equal(oldTree, this.latestTree, "incremental samples must retain the previous tree");
          const { edited } = oldTree;
          // The edit must describe exactly how the new text differs from the edited tree's text.
          assert.equal(text.slice(0, edited.startIndex), oldTree.text.slice(0, edited.startIndex));
          assert.equal(text.slice(edited.newEndIndex), oldTree.text.slice(edited.oldEndIndex));
          assert.deepEqual(
            // Copies the benchmark context's points into this realm, which strict deep equality requires.
            [edited.startPosition, edited.oldEndPosition, edited.newEndPosition].map(({ row, column }) => ({
              row,
              column
            })),
            [
              point(oldTree.text, edited.startIndex),
              point(oldTree.text, edited.oldEndIndex),
              point(text, edited.newEndIndex)
            ]
          );
          editedTrees++;
        }
        pendingTrees++;
        peakPendingTrees = Math.max(peakPendingTrees, pendingTrees);
        clock++;
        this.latestTree = {
          text,
          rootNode: { hasError: false },
          edit(edit) {
            this.edited = edit;
          },
          // One kilobyte per key stays below a quarter of the typing template.
          getChangedRanges: () => [{ startIndex: 0, endIndex: 1024 }]
        };
        return this.latestTree;
      }
    }
    const local = name => {
      if (name === "tree-sitter") return Parser;
      if (name === "./bindings/node") return scss;
      if (name === "tree-sitter/package.json") return { version: "test" };
      if (name === "node-gyp-build") return { path: () => "test.node" };
      throw new Error(`Unexpected dependency ${name}`);
    };
    const context = {
      __dirname,
      console: { log: text => (output = JSON.parse(text)), error: error => assert.fail(String(error)) },
      process: {
        version: process.version,
        platform: process.platform,
        arch: process.arch,
        resourceUsage: () => ({ maxRSS: 123 }),
        memoryUsage: () => ({ rss: 456 })
      },
      require: name => {
        if (name === "node:module") return { createRequire: () => local };
        if (name === "node:perf_hooks") return { performance: { now: () => clock } };
        if (name === "node:util") return { parseArgs: () => ({ values: {} }) };
        if (name === "node:fs") {
          return {
            readFileSync: path => {
              if (path.endsWith("parser.c")) {
                return Buffer.from("#define STATE_COUNT 1\n#define LARGE_STATE_COUNT 1\n");
              }
              return ".a {}";
            },
            statSync: () => ({ size: 1 })
          };
        }
        if (name === "node:timers/promises") {
          return {
            setImmediate: async () => {
              assert.equal(collected, forcedGc, "force collection before yielding when available");
              collected = false;
              pendingTrees = 0;
              clock += 10000;
            }
          };
        }
        return require(name);
      }
    };
    if (forcedGc) context.gc = () => (collected = true);

    await runInNewContext(source, context);

    assert.equal(peakPendingTrees, 1000, "only a single small/nested batch may accumulate retired trees");
    assert.equal(pendingTrees, 0, "the final dialect must also drain before memory reporting");
    assert.equal(
      editedTrees,
      2 * (220 + 2 * 639),
      "both dialects retain numeric incremental samples and type every key at both insertion points"
    );
    const workloads = [
      "small",
      "stress",
      "medium",
      "large",
      "nested",
      "spaced-pseudos",
      "multiline-pseudos",
      "long-comment-lines",
      "interpolated-values"
    ];
    const typing = ["typing-blank", "typing-same-line"];
    // Every measured input has a hash; the incremental edit reuses the large workload's text.
    assert.deepEqual(Object.keys(output.workloads), [...workloads, ...typing]);
    assert.deepEqual(
      output.results.map(result => result.dialect),
      ["scss", "css"]
    );
    for (const { queryCompileMs, results } of output.results) {
      assert.equal(queryCompileMs, 7, "compile the query once outside parse and capture timing");
      assert.deepEqual(
        results.map(result => result.workload),
        [...workloads, "edit-large", ...typing]
      );
      for (const result of results) {
        assert.deepEqual(result.parse, { p50Ms: 1, p95Ms: 1 });
        if (typing.includes(result.workload)) {
          const { keys, changedKB, keysChangingQuarterFile, errorKeys } = result;
          assert.deepEqual(
            { keys, changedKB, keysChangingQuarterFile, errorKeys },
            {
              keys: 639,
              changedKB: 639,
              keysChangingQuarterFile: 0,
              errorKeys: 0
            }
          );
          continue;
        }
        if (result.workload === "edit-large") continue;
        assert.deepEqual(result.highlight, { p50Ms: 2, p95Ms: 2 });
        assert.deepEqual(result.total, { p50Ms: 3, p95Ms: 3 });
        assert.equal(result.captures, 2);
        assert.equal(result.errorFiles, 0);
      }
    }
    assert.equal(output.gcBetweenParseSamples, forcedGc);
    assert.equal(output.maxRssKiB, 123);
    assert.equal(output.processRssAfterCleanupBytes, 456);
  });
}
