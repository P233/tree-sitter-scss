/* global self */
import { Parser, Language, Query } from "./vendor/web-tree-sitter.js";
import { highlight, differentLines, describeTree } from "./highlight.mjs";

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

self.onmessage = ({ data: source }) => {
  try {
    if (typeof source !== "string" || source.length > 128 * 1024)
      throw new Error("Keep source under 128 Ki characters.");
    const results = engines.map(({ parser, query }) => {
      const tree = parser.parse(source);
      if (!tree) throw new Error("Parser did not return a tree.");
      try {
        return { ...highlight(source, query.captures(tree.rootNode), manifest.themes), ...describeTree(tree.rootNode) };
      } finally {
        tree.delete();
      }
    });
    const differences = differentLines(source, results);
    self.postMessage({
      type: "result",
      source,
      differences,
      results: results.map(({ segments: _segments, ...result }) => result)
    });
  } catch (error) {
    self.postMessage({ type: "error", message: error.message });
  }
};
