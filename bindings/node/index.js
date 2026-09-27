const { readFileSync } = require("node:fs");
const { join } = require("node:path");

const root = join(__dirname, "../..");
const binding = require("node-gyp-build")(root);
binding.name = "scss";
binding.nodeTypeInfo = require("../../src/node-types.json");
binding.HIGHLIGHTS_QUERY = readFileSync(join(root, "queries/highlights.scm"), "utf8");

module.exports = binding;
