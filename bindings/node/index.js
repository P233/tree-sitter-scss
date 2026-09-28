const { readFileSync } = require("node:fs");
const { join } = require("node:path");

const root = join(__dirname, "../..");
const binding = require("node-gyp-build")(root);
const nodeTypeInfo = require("../../src/node-types.json");
const HIGHLIGHTS_QUERY = readFileSync(join(root, "queries/highlights.scm"), "utf8");

module.exports = {
  name: "scss",
  language: binding.language,
  nodeTypeInfo,
  HIGHLIGHTS_QUERY,
  cssLanguage: {
    name: "stylesheet-css",
    language: binding.cssLanguage,
    nodeTypeInfo,
    HIGHLIGHTS_QUERY
  }
};
