// Use a fresh process so each preview loads the rebuilt native binding.
const { readFileSync } = require("node:fs");
const Parser = require("tree-sitter");
const Scss = require("../bindings/node");

const parser = new Parser();
parser.setLanguage(Scss);
const tree = parser.parse(readFileSync(process.argv[2], "utf8"));
const valid = !tree.rootNode.hasError;
let depth = 0;
// Quoted diagnostic tokens, such as (MISSING ")"), must not change the nesting depth.
const formattedTree = tree.rootNode.toString().replace(/".*?"(?=\))|'.*?'(?=\))|[()]| (?:\w+: )?(?=\()/g, token => {
  if (token === "(") depth++;
  else if (token === ")") depth--;
  else if (token.startsWith(" ")) return `\n${"  ".repeat(depth)}${token.slice(1)}`;
  return token;
});
console.log(
  JSON.stringify({
    valid,
    diagnostics: (valid ? "" : "Tree contains ERROR or MISSING nodes.\n") + formattedTree
  })
);
