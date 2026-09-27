// Use a fresh process so each preview loads the rebuilt native binding.
const { readFileSync } = require("node:fs");
const Parser = require("tree-sitter");
const Scss = require("../bindings/node");

const parser = new Parser();
parser.setLanguage(Scss);
const tree = parser.parse(readFileSync(process.argv[2], "utf8"));
const valid = !tree.rootNode.hasError;
console.log(
  JSON.stringify({
    valid,
    diagnostics: (valid ? "" : "Tree contains ERROR or MISSING nodes.\n") + tree.rootNode.toString()
  })
);
