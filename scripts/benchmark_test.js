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
    const scss = { name: "scss", cssLanguage: { name: "css" } };
    class Parser {
      setLanguage(language) {
        this.language = language;
      }
      parse(_text, oldTree) {
        if (oldTree) {
          assert.equal(pendingTrees, 0, "retired trees must drain before the next edit sample");
          assert.equal(oldTree, this.latestTree, "incremental samples must retain the previous tree");
          assert.equal(oldTree.edited, true);
          editedTrees++;
        }
        pendingTrees++;
        peakPendingTrees = Math.max(peakPendingTrees, pendingTrees);
        clock++;
        this.latestTree = {
          edit() {
            this.edited = true;
          }
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
    assert.equal(editedTrees, 440, "both dialects retain the existing warmup and measured edit counts");
    const workloads = [
      "small",
      "stress",
      "medium",
      "large",
      "nested",
      "unmatched",
      "spaced-pseudos",
      "multiline-pseudos",
      "long-comment-lines",
      "interpolated-values"
    ];
    assert.deepEqual(Object.keys(output.workloads), workloads);
    // Each dialect reports every workload plus the incremental edit.
    assert.deepEqual(
      output.results.map(result => `${result.dialect}:${result.workload}`),
      ["scss", "css"].flatMap(dialect => [...workloads, "edit-large"].map(workload => `${dialect}:${workload}`))
    );
    assert.ok(
      output.results.every(result => result.p50Ms === 1 && result.p95Ms === 1),
      "cleanup must be untimed"
    );
    assert.equal(output.gcBetweenParseSamples, forcedGc);
    assert.equal(output.maxRssKiB, 123);
    assert.equal(output.processRssAfterCleanupBytes, 456);
  });
}
