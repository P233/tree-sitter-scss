const assert = require("node:assert/strict");
const { test } = require("node:test");
const Parser = require("tree-sitter");
const Scss = require("./index.js");

test("reloading the JavaScript entry preserves both native language exports", () => {
  const entry = require.resolve("./index.js");
  for (let i = 0; i < 3; i++) {
    delete require.cache[entry];
    const reloaded = require("./index.js");
    for (const language of [Scss, Scss.cssLanguage, reloaded, reloaded.cssLanguage]) {
      const parser = new Parser();
      parser.setLanguage(language);
      assert.equal(parser.parse(".a { color: red; }").rootNode.hasError, false);
    }
    assert.equal(reloaded.cssLanguage.language, Scss.cssLanguage.language);
  }
});

function parse(source) {
  const parser = new Parser();
  parser.setLanguage(Scss);
  const tree = parser.parse(source);
  assert.equal(tree.rootNode.hasError, false, tree.rootNode.toString());
  return tree;
}

const examples = [
  ["property declarations", "body { position: relative; color: red; }"],
  ["hyphenated variables and flags", "$base-color: #abc !default !global; .card { color: $base-color; }"],
  ["empty and comma-separated calls", "$value: foo(); $color: rgb(1, 2, 3);"],
  ["named arguments and modules", "$value: math.div($number: 4, $divisor: 2);"],
  ["lists and maps", '$list: [1, 2, 3]; $map: ("small": 1, large: (width: 2px));'],
  ["trailing commas", "$list: (1,); $map: (small: 1,); $value: foo(1,);"],
  ["booleans and null", "$enabled: true; $disabled: false; $empty: null;"],
  ["selector groups and nesting", ".a, #b, h1 { .child { width: 1px; } }"],
  ["interpolated names", ".icon-#{$name} { margin-#{$side}: 1px; }"],
  ["quoted URL", '$url: "https://example.com";'],
  ["comment markers inside strings", '$text: "/* literal */ // literal";'],
  ["escaped quotes", String.raw`$text: "a\"b"; $other: 'a\'b';`],
  ["string interpolation", '$text: "hello #{$name}!";'],
  ["ordinary hash in strings", '$text: "color #fff";'],
  ["non-nesting block comments", "/* outer /* inner */ body { color: red; }"],
  ["units and scientific notation", "$size: -1.5e2px; $ratio: 20%;"],
  ["plain values followed by lists", "$value: foo (1 2);"]
];

for (const [name, source] of examples) {
  test(name, () => parse(source));
}

test("selector and property nodes preserve their full text", () => {
  const tree = parse(".foo bar { color: red; }");
  const nodes = tree.rootNode.descendantsOfType(["class_selector", "tag_selector", "property_name", "plain_value"]);
  assert.deepEqual(
    nodes.map(node => [node.type, node.text]),
    [
      ["class_selector", ".foo"],
      ["tag_selector", "bar"],
      ["property_name", "color"],
      ["plain_value", "red"]
    ]
  );
});

test("string content never becomes a comment", () => {
  const tree = parse('$text: "https://example.com /* literal */";');
  assert.equal(tree.rootNode.descendantsOfType(["block_comment", "inline_comment"]).length, 0);
});

test("a spaced identifier after a number is not a unit", () => {
  const tree = parse("$value: 1 em;");
  assert.equal(tree.rootNode.descendantsOfType("unit").length, 0);
  assert.equal(tree.rootNode.descendantsOfType("plain_value")[0].text, "em");
});

test("invalid token boundaries are rejected", () => {
  const parser = new Parser();
  parser.setLanguage(Scss);
  for (const source of ["$ value: 1;", '$text: "raw\nnewline";']) {
    assert.equal(parser.parse(source).rootNode.hasError, true, source);
  }
});

test("highlight queries capture identifiers and interpolation separately", () => {
  const tree = parse('.foo { color: $base-color; content: "hello #{$name}"; }');
  const query = new Parser.Query(Scss, Scss.HIGHLIGHTS_QUERY);
  const captures = query.captures(tree.rootNode).map(({ name, node }) => [name, node.text]);
  for (const expected of [
    ["attribute", ".foo"],
    ["property", "color"],
    ["variable", "$base-color"],
    ["string", '"hello #{$name}"'],
    ["variable", "$name"],
    ["punctuation.special", "#{"]
  ]) {
    assert.ok(
      captures.some(capture => capture[0] === expected[0] && capture[1] === expected[1]),
      JSON.stringify(expected)
    );
  }
});

test("an incremental edit agrees with a fresh parse", () => {
  const parser = new Parser();
  parser.setLanguage(Scss);
  const source = "body { color: red; }";
  const tree = parser.parse(source);
  const startIndex = source.indexOf("red");
  const replacement = "$base-color";
  tree.edit({
    startIndex,
    oldEndIndex: startIndex + 3,
    newEndIndex: startIndex + replacement.length,
    startPosition: { row: 0, column: startIndex },
    oldEndPosition: { row: 0, column: startIndex + 3 },
    newEndPosition: { row: 0, column: startIndex + replacement.length }
  });
  const edited = source.slice(0, startIndex) + replacement + source.slice(startIndex + 3);
  const incremental = parser.parse(edited, tree);
  assert.equal(incremental.rootNode.hasError, false);
  assert.equal(incremental.rootNode.toString(), parse(edited).rootNode.toString());
});

test("an unfinished value preserves its declaration and the following rule", () => {
  const parser = new Parser();
  parser.setLanguage(Scss);
  const tree = parser.parse(".broken { color: ; } .good { width: 1px; }");
  assert.equal(tree.rootNode.hasError, false);
  assert.equal(tree.rootNode.descendantsOfType("property_declaration")[0].text, "color: ;");
  assert.ok(tree.rootNode.descendantsOfType("property_name").some(node => node.text === "width"));
});
