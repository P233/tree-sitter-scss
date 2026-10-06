const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { join } = require("node:path");
const { test } = require("node:test");
const Parser = require("tree-sitter");
const Scss = require("./index.js");

const query = new Parser.Query(Scss, Scss.HIGHLIGHTS_QUERY);
const stress = readFileSync(join(__dirname, "../../examples/highlight-stress.scss"), "utf8");

function parse(source, parser = new Parser(), previous) {
  parser.setLanguage(Scss);
  const tree = parser.parse(source, previous);
  const errors = [];
  function visit(node) {
    if (node.type === "ERROR" || node.isMissing) {
      errors.push(
        `${node.type} at ${node.startPosition.row + 1}:${node.startPosition.column + 1}: ${node.text.slice(0, 60)}`
      );
    }
    node.children.forEach(visit);
  }
  visit(tree.rootNode);
  assert.deepEqual(errors, []);
  return tree;
}

function texts(tree, type) {
  return tree.rootNode.descendantsOfType(type).map(node => node.text);
}

// `;` and colons outside pseudo-classes are deliberately uncaptured.
function assertCovered(source, tree) {
  const covered = new Uint8Array(source.length);
  for (const { name, node } of query.captures(tree.rootNode)) {
    if (!name.startsWith("_")) covered.fill(1, node.startIndex, node.endIndex);
  }
  for (const node of tree.rootNode.descendantsOfType([":", ";"])) covered.fill(1, node.startIndex, node.endIndex);
  const gaps = [];
  for (let i = 0; i < source.length; i++) {
    if (!covered[i] && !/\s/.test(source[i])) gaps.push(`${i}: ${source.slice(i, i + 12)}`);
  }
  assert.deepEqual(gaps, []);
}

// Separate sections prevent one runaway comment/raw value from hiding later code.
for (const section of stress.split(/(?=^\/\/ === )/m).slice(1)) {
  const title = section.match(/^\/\/ === (\d+ .+?) =/);
  if (!title) continue;
  test(`stress ${title[1]} parses and covers every non-whitespace character`, () => {
    assertCovered(section, parse(section));
  });
}

test("the combined fixture preserves its final rule and capture coverage", () => {
  const tree = parse(stress);
  assertCovered(stress, tree);
  assert.ok(texts(tree, "id_selector").includes("#stress-final-id"));
  assert.ok(texts(tree, "property_name").includes("content"));
});

test("raw CSS values enter SassScript only through interpolation", () => {
  const source =
    '.x { --raw: $ink true and 1+2; --live: #{$ink}; --quoted: "#{$ink}"; --escaped: "\\#{$ink}"; result: $ink; #{$name}: $ink; } @function --f() { result: $ink; }';
  const tree = parse(source);
  assert.deepEqual(texts(tree, "variable_name"), ["$ink", "$ink", "$ink", "$name", "$ink"]);
  assert.ok(texts(tree, "raw_text").includes("$ink"));
  // Raw CSS tokens keep typed nodes, but Sass literals and word operators remain plain words.
  assert.equal(texts(tree, "boolean").length, 0);
  assert.ok(texts(tree, "plain_value").includes("true") && texts(tree, "plain_value").includes("and"));
  assert.deepEqual(texts(tree, "number"), ["1", "2"]);
  assert.deepEqual(texts(tree, "operator"), ["+"]);
  assertCovered(source, tree);
});

test("raw slashes and URL payloads never become silent comments", () => {
  const source =
    '.x { --raw: alpha // beta; --url: https://test/a//b; --block: { a: b; c: d }; color: red; background: url(https://test/a//b?q=1#x); mask: URL( spaced.png ); image: url(#{$path}/a.svg); cursor: url($path + "/b.svg"); }';
  const tree = parse(source);
  assert.deepEqual(texts(tree, "inline_comment"), []);
  assert.equal(texts(tree, "url").length, 4);
  assert.deepEqual(texts(tree, "variable_name"), ["$path", "$path"]);
  assert.ok(texts(tree, "property_name").includes("color"));
  assertCovered(source, tree);
});

test("comment interpolation is active only in block comments", () => {
  const source = "/* #{1 + 2} /* literal nested opener */ .x { color: red; } // #{$ignored}\n.y {}";
  const tree = parse(source);
  assert.deepEqual(texts(tree, "interpolation"), ["#{1 + 2}"]);
  assert.deepEqual(texts(tree, "class_selector"), [".x", ".y"]);
});

test("escaped literals and keyword-shaped identifiers keep complete boundaries", () => {
  const tree = parse(
    String.raw`$x: true, tr\75 e, false, n\75 ll, trueish, falsehood, null-value, notebook, TRUE, False, NULL, urlish(1);`
  );
  assert.deepEqual(texts(tree, "boolean"), ["true", "false"]);
  assert.deepEqual(texts(tree, "null"), []);
  assert.deepEqual(texts(tree, "function_name"), ["urlish"]);
  for (const word of [String.raw`tr\75 e`, String.raw`n\75 ll`, "trueish"])
    assert.ok(texts(tree, "plain_value").includes(word));
});

test("hex colors and hash strings are never split at a valid color prefix", () => {
  const tree = parse("$x: #abc, #abcd, #abcdef, #abcdef01, #foo, #abcdfoo, #ggg;");
  assert.deepEqual(texts(tree, "hex_color"), ["#abc", "#abcd", "#abcdef", "#abcdef01"]);
  assert.deepEqual(texts(tree, "hash_value"), ["#foo", "#abcdfoo", "#ggg"]);
});

test("numeric operators, exponent signs, and vendor prefixes stay distinct", () => {
  const tree = parse("$x: 1px-2px, 1-2, -1.5e-2px, 1.2.3, -webkit-box;");
  assert.deepEqual(texts(tree, "number"), ["1px", "2px", "1", "2", "-1.5e-2px", "1.2", ".3"]);
  assert.deepEqual(texts(tree, "operator"), ["-", "-"]);
  assert.deepEqual(texts(tree, "plain_value"), ["-webkit-box"]);
});

test("CSS escapes preserve their full extent and only one terminating space", () => {
  const tree = parse(
    String.raw`$x: "\41B \41 B \000041B \41  B \1F9EA "; $stress-\67 ap: 1; .\31 0-columns { c\6flor: red; }`
  );
  assert.deepEqual(texts(tree, "escape_sequence"), [
    String.raw`\41B `,
    String.raw`\41 `,
    String.raw`\000041`,
    String.raw`\41 `,
    String.raw`\1F9EA `
  ]);
  assert.ok(texts(tree, "variable_name").includes(String.raw`$stress-\67 ap`));
  assert.deepEqual(texts(tree, "class_selector"), [String.raw`.\31 0-columns`]);
  assert.deepEqual(texts(tree, "property_name"), [String.raw`c\6flor`]);
});

test("colon spacing distinguishes nested properties from pseudo selectors", () => {
  const tree = parse(".x { a:hover {} font:bold {} font: bold { family: serif; } #{$tag}:hover {} #{$side}: 0; }");
  assert.deepEqual(texts(tree, "pseudo_name"), ["hover", "bold", "hover"]);
  assert.equal(
    tree.rootNode.descendantsOfType("property_declaration").filter(node => node.childForFieldName("body")).length,
    1
  );
  assert.deepEqual(texts(tree, "property_name"), ["font", "family", "#{$side}"]);
});

test("interpolated names retain their prefix and suffix as one node", () => {
  const tree = parse('.a-#{$x}-#{$y} { &-#{$x} {} @at-root #{&}__suffix {} image: linear-#{"gradient"}(red, blue); }');
  assert.deepEqual(texts(tree, "class_selector"), [".a-#{$x}-#{$y}"]);
  assert.ok(texts(tree, "tag_selector").includes("#{&}__suffix"));
  assert.ok(texts(tree, "function_name").includes('linear-#{"gradient"}'));
});

test("else clauses remain attached across comments and newlines", () => {
  const tree = parse("@if true {} // comment\n@else if false {}\n@else {}");
  assert.equal(texts(tree, "if_statement").length, 1);
  assert.equal(texts(tree, "else_clause").length, 2);
});

test("modern conditional branches and CSS typed signatures stay balanced", () => {
  const source =
    "@function --color(--ink <color>: teal) returns <color> { result: var(--ink, #{$ink}); } .x { display: if(supports(display: grid): grid; style(--wide: yes): flex; else: block;); color: red; }";
  const tree = parse(source);
  assert.equal(texts(tree, "conditional_branch").length, 3);
  assert.equal(texts(tree, "type_annotation").length, 2);
  assert.equal(texts(tree, "function_definition").length, 1);
  assertCovered(source, tree);
});

test("unknown directives retain complete names and balanced preludes", () => {
  const source = "@media-custom (x: y); @unknown [a, b] (c: d); @#{$name} token(foo: bar) { .x {} }";
  const tree = parse(source);
  assert.deepEqual(texts(tree, "at_keyword"), ["@media-custom", "@unknown", "@#{$name}"]);
  assertCovered(source, tree);
});

test("escaped directives retain complete generic names in both dialects", () => {
  const source = String.raw`@m\65 dia screen and (width >= 1px) { .x {} } @\75 se "sass:math"; @\6D ixin ring($x) {} @\mixin other {} $x: \6E ull, \null, \true, fals\65 ;`;
  const tree = parse(source);
  assert.deepEqual(texts(tree, "at_keyword"), [
    String.raw`@m\65 dia`,
    String.raw`@\75 se`,
    String.raw`@\6D ixin`,
    String.raw`@\mixin`
  ]);
  assert.deepEqual(texts(tree, "query_statement"), []);
  assert.deepEqual(texts(tree, "plain_value"), [
    "screen",
    "and",
    "width",
    "other",
    String.raw`\6E ull`,
    String.raw`\null`,
    String.raw`\true`,
    String.raw`fals\65 `
  ]);
  assert.deepEqual(texts(tree, "boolean"), []);
  assert.deepEqual(texts(tree, "null"), []);
  assertCovered(source, tree);
});

test("keyword-shaped namespaces retain module roles in every reference", () => {
  const names = ["true", "false", "null", "not", "and", "or", "if", "selector", "URL", "element", String.raw`\null`];
  for (const name of names) {
    const source = `@use "x" as ${name}; $x: ${name}.$value, ${name}.foo(1); @include ${name}.bar;`;
    const tree = parse(source);
    assert.deepEqual(texts(tree, "module_name"), [name, name, name, name]);
    assert.deepEqual(texts(tree, "boolean"), []);
    assert.deepEqual(texts(tree, "null"), []);
    assertCovered(source, tree);
  }
});

test("function-shaped module aliases and escaped custom properties retain their roles", () => {
  const tree = parse(String.raw`$x: url.$value, if.$value, selector.append("a", "b"); .x { --f\6fo: $raw; }`);
  assert.deepEqual(texts(tree, "module_name"), ["url", "if", "selector"]);
  assert.deepEqual(texts(tree, "function_name"), ["append"]);
  assert.deepEqual(texts(tree, "property_name"), [String.raw`--f\6fo`]);
  assert.deepEqual(texts(tree, "raw_text"), ["$raw"]);
});

test("nth formulas are distinct from dimension values and selector arguments", () => {
  const source = ".x:nth-child(2n+1 of .item):nth-last-child(-n + 3):nth-child(#{$n}n + 1):lang(zh) {}";
  const tree = parse(source);
  assert.deepEqual(texts(tree, "nth_formula"), ["2n+1", "-n + 3", "#{$n}n + 1"]);
  assert.deepEqual(texts(tree, "unit"), []);
  assertCovered(source, tree);
});

test("incremental context changes agree with fresh trees and capture ranges", () => {
  for (const [before, after] of [
    ["$ink", "#{$ink}"],
    ["12px", "12"],
    ["/* x */", "/* #{1} */"],
    ["a:hover {}", "a: hover {}"]
  ]) {
    const prefix = '.🧪 { content: "界"; --value: ';
    const source = before.includes("{}") ? `.🧪 { ${before} }` : `${prefix}${before}; color: red; }`;
    const parser = new Parser();
    const tree = parse(source, parser);
    const startIndex = source.indexOf(before);
    tree.edit({
      startIndex,
      oldEndIndex: startIndex + before.length,
      newEndIndex: startIndex + after.length,
      startPosition: { row: 0, column: startIndex },
      oldEndPosition: { row: 0, column: startIndex + before.length },
      newEndPosition: { row: 0, column: startIndex + after.length }
    });
    const edited = source.slice(0, startIndex) + after + source.slice(startIndex + before.length);
    const incremental = parse(edited, parser, tree);
    const fresh = parse(edited);
    assert.equal(incremental.rootNode.toString(), fresh.rootNode.toString());
    const ranges = tree =>
      query.captures(tree.rootNode).map(({ name, node }) => [name, node.startIndex, node.endIndex]);
    assert.deepEqual(ranges(incremental), ranges(fresh));
  }
});

test("structural editing errors remain visible and recover after repair", () => {
  const parser = new Parser();
  parser.setLanguage(Scss);
  for (const source of [
    ".x { color: #; } .sentinel { width: 1px; }",
    ".x { --raw: [one (two]; }",
    '$x: "bad\nline";',
    ".x { color: #{}; }"
  ]) {
    const broken = parser.parse(source);
    assert.equal(broken.rootNode.hasError, true, source);
    const fixed = parser.parse(".sentinel { width: 1px; }");
    assert.equal(fixed.rootNode.hasError, false);
  }
});
