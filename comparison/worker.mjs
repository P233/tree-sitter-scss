/* global self */
import { Parser, Language, Query } from "./vendor/web-tree-sitter.js";
import { highlight, differentLines, describeTree } from "./highlight.mjs";
import { measureWarm, warmUp } from "./parse.mjs";

let manifest;
let engines;
try {
  const response = await fetch(new URL("./manifest.json", import.meta.url));
  if (!response.ok) throw new Error(`Could not load manifest (${response.status}).`);
  manifest = await response.json();
  await Parser.init({ locateFile: name => new URL(`./vendor/${name}`, import.meta.url).href });
  engines = await Promise.all(
    manifest.engines.map(async engine => {
      const language = await Language.load(new URL(engine.wasm, import.meta.url).href);
      const response = await fetch(new URL(engine.query, import.meta.url));
      if (!response.ok) throw new Error(`Could not load ${engine.query} (${response.status}).`);
      const parser = new Parser();
      parser.setLanguage(language);
      return { parser, query: new Query(language, await response.text()) };
    })
  );
  self.postMessage({ type: "ready", manifest });
} catch (error) {
  self.postMessage({ type: "error", fatal: true, message: error.message });
}

function highlightedRun(parser, query, source) {
  const tree = parser.parse(source);
  if (!tree) return tree;
  try {
    highlight(source, query.captures(tree.rootNode), manifest.themes);
  } catch (error) {
    tree.delete();
    throw error;
  }
  return tree;
}

self.onmessage = ({ data: { id, source } }) => {
  try {
    if (typeof source !== "string" || source.length > 128 * 1024)
      throw new Error("Keep source under 128 Ki characters.");
    const results = engines.map(({ parser, query }) => {
      const tree = parser.parse(source);
      if (!tree) throw new Error("Parser did not return a tree.");
      try {
        return {
          ...highlight(source, query.captures(tree.rootNode), manifest.themes),
          ...describeTree(tree.rootNode)
        };
      } finally {
        tree.delete();
      }
    });
    const differences = differentLines(source, results);
    self.postMessage({
      type: "result",
      id,
      source,
      differences,
      results: results.map(({ segments: _segments, ...result }) => result)
    });
  } catch (error) {
    self.postMessage({ type: "error", id, message: error.message });
    return;
  }
  try {
    // Without this, the engine timed first also pays for warming up the shared runtime and reads slow.
    for (const { parser, query } of engines) warmUp(() => highlightedRun(parser, query, source), 20);
    const timings = engines.map(({ parser, query }) => ({
      parse: measureWarm(() => parser.parse(source)),
      highlighted: measureWarm(() => highlightedRun(parser, query, source))
    }));
    self.postMessage({ type: "timing", id, timings });
  } catch (error) {
    self.postMessage({ type: "timing-error", id, message: error.message });
  }
};
