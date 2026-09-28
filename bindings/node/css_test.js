const assert = require("node:assert/strict");
const { test } = require("node:test");
const Parser = require("tree-sitter");
const Scss = require("./index.js");

function parse(source, parser = new Parser(), previous, language = Scss.cssLanguage) {
  parser.setLanguage(language);
  const tree = parser.parse(source, previous);
  assert.equal(tree.rootNode.hasError, false, `${source}\n${tree.rootNode.toString()}`);
  return tree;
}

function texts(tree, type) {
  return tree.rootNode.descendantsOfType(type).map(node => node.text);
}

test("CSS literal interpolation-like strings preserve following declarations", () => {
  for (const value of ['"#{"', "'#{text'", '"#{}"', '"#{foo: bar}"', '"#{foo?bar}"', '"#{(text}"']) {
    const tree = parse(`.a { content: ${value}; color: red; } .sentinel { display: grid; }`);
    assert.deepEqual(texts(tree, "string"), [value]);
    assert.deepEqual(texts(tree, "interpolation"), []);
    assert.deepEqual(texts(tree, "property_name"), ["content", "color", "display"]);
  }
});

test("CSS comments end before following rules even after incomplete interpolation", () => {
  for (const comment of [
    "/* #{ */",
    "/* #{text */",
    '/* #{"}" */',
    "/* #{foo:bar} */",
    "/* #{(foo */",
    String.raw`/* #{"\*/`
  ]) {
    const tree = parse(`${comment} .sentinel { color: red; } /* } */`);
    assert.equal(texts(tree, "block_comment")[0], comment);
    assert.deepEqual(texts(tree, "class_selector"), [".sentinel"]);
    assert.deepEqual(texts(tree, "property_name"), ["color"]);
  }
});

test("literal string boundaries cannot merge following quoted declarations", () => {
  for (const source of [
    '.a{content:"#{foo";other:"bar}";} .b{color:red;}',
    '.a{content:"#{";other:"bar}";} .b{color:red;}',
    '.a{content:"#{foo(";other:"bar)}";} .b{color:red;}',
    '.a{content:"#{foo(x";other:"bar)}";} .b{color:red;}',
    '.a{content:"#{foo"} .b{other:"bar}";color:red;}',
    ".a{content:'#{foo';other:'bar}';} .b{color:red;}"
  ]) {
    const tree = parse(source);
    assert.deepEqual(texts(tree, "property_name"), ["content", "other", "color"]);
    assert.equal(texts(tree, "property_declaration").length, 3);
    assert.equal(texts(tree, "interpolation").length, 0);
  }
});

test("valid SCSS interpolations keep their expression nodes in every literal host", () => {
  const expression = '#{map.get($theme, "color")}';
  const tree = parse(
    `/* ${expression} */ .a { content: "${expression}"; --color: ${expression}; }`,
    new Parser(),
    undefined,
    Scss
  );
  assert.deepEqual(texts(tree, "interpolation"), [expression, expression, expression]);
  assert.deepEqual(texts(tree, "module_name"), ["map", "map", "map"]);
  assert.deepEqual(texts(tree, "function_name"), ["get", "get", "get"]);
});

test("quoted Sass list items and word operators remain inside interpolation", () => {
  for (const expression of ['#{not "a"}', '#{"a" "b"}', '#{"a" + "b"}', '#{";"}', '#{"}text"}']) {
    const tree = parse(`.a { content: "${expression}"; color: red; }`, new Parser(), undefined, Scss);
    assert.deepEqual(texts(tree, "interpolation"), [expression]);
    assert.deepEqual(texts(tree, "property_name"), ["content", "color"]);
  }
});

test("CSS custom-property raw groups accept literal interpolation delimiters", () => {
  const tree = parse(".a { --empty: #{}; --record: #{name: value}; --nested: #{[one, two]}; color: red; }");
  assert.ok(texts(tree, "raw_group").includes("#{}"));
  assert.ok(texts(tree, "raw_group").includes("#{name: value}"));
  assert.deepEqual(texts(tree, "property_name"), ["--empty", "--record", "--nested", "color"]);
});

test("CSS URLs keep hashes, dollars, and apparent interpolation as literal payloads", () => {
  const source =
    '.a { background: url(#{$color}); cursor: URL($path); mask: url(foo#{}?q=$value); image: url("#{$name}"); }';
  const tree = parse(source);
  assert.equal(texts(tree, "url").length, 4);
  assert.deepEqual(texts(tree, "interpolation"), []);
  assert.deepEqual(texts(tree, "variable_name"), []);
  assert.ok(texts(tree, "raw_text").includes("#{$color}"));
  assert.ok(texts(tree, "raw_text").includes("$path"));
  assert.deepEqual(texts(tree, "property_name"), ["background", "cursor", "mask", "image"]);
});

test("empty values remain structural declarations with and without semicolons", () => {
  const tree = parse(".a { color: ; --raw: ; padding: } .b { display: flex; }");
  assert.deepEqual(texts(tree, "property_declaration"), ["color: ;", "--raw: ;", "padding:", "display: flex;"]);
});

test("case-insensitive CSS directives retain specialized statement roles", () => {
  const tree = parse(
    String.raw`@MEDIA screen { .a {} } @SuPpOrTs (display: grid) {} @KeyFrames fade { FROM {} TO {} } @LAYER base; @FONT-FACE { font-family: example; }`
  );
  assert.equal(texts(tree, "query_statement").length, 2);
  assert.equal(texts(tree, "keyframes_statement").length, 1);
  assert.equal(texts(tree, "css_statement").length, 2);
});

test("CSS legacy HTML comment markers do not hide stylesheet rules", () => {
  const tree = parse("<!-- .a { color: red; } --> .b { display: flex; }");
  assert.deepEqual(texts(tree, "class_selector"), [".a", ".b"]);
});

test("modern CSS uses the same parser and structural nodes as SCSS", () => {
  const tree = parse(`@layer base { @container card (width >= 30rem) {
    .card { & > .title { color: oklch(60% .2 200); } --path: https://example.test/a; }
  } } @scope (.card) to (.nested) { :scope { display: grid; } }`);
  assert.equal(texts(tree, "query_statement").length, 1);
  assert.equal(texts(tree, "scope_statement").length, 1);
  assert.ok(texts(tree, "property_declaration").some(text => text.startsWith("--path:")));
});

test("scope limits and CSS selector keywords retain specialized nodes", () => {
  for (const source of [
    "@scope to (.limit) { .a {} }",
    "@scope (.root) TO (.limit) { .a {} }",
    ".a:NTH-CHILD(ODD) {}",
    ".a:nth-child(2N+1 OF .item) {}",
    ".a:Nth-Last-Child(Even) {}"
  ]) {
    for (const language of [Scss, Scss.cssLanguage]) {
      const tree = parse(source, new Parser(), undefined, language);
      assert.equal(texts(tree, source.startsWith("@scope") ? "scope_statement" : "nth_arguments").length, 1);
    }
  }
});

test("URLs and escaped units keep complete boundaries without swallowing following rules", () => {
  const source = String.raw`.a { background: URL(https://example.test/a); width: 1p\78 ; } .next { width: 1px-2px; }`;
  for (const language of [Scss, Scss.cssLanguage]) {
    const tree = parse(source, new Parser(), undefined, language);
    assert.deepEqual(texts(tree, "url"), ["URL(https://example.test/a)"]);
    assert.deepEqual(texts(tree, "number"), [
      String.raw`1p\78 `,
      ...(language === Scss ? ["1px", "2px"] : ["1px-2px"])
    ]);
    assert.deepEqual(texts(tree, "inline_comment"), []);
    assert.deepEqual(texts(tree, "class_selector"), [".a", ".next"]);
  }
});

test("ordinary CSS has identical syntax trees and captures through both language entries", () => {
  const source = "@media (width >= 40rem) { .card, .panel { color: red; display: grid; & > .title {} } }";
  const cssTree = parse(source);
  const scssTree = parse(source, new Parser(), undefined, Scss);
  assert.equal(cssTree.rootNode.toString(), scssTree.rootNode.toString());
  function captures(language, tree) {
    return new Parser.Query(language, language.HIGHLIGHTS_QUERY)
      .captures(tree.rootNode)
      .map(({ name, node }) => [name, node.startIndex, node.endIndex]);
  }
  assert.deepEqual(captures(Scss.cssLanguage, cssTree), captures(Scss, scssTree));
});

test("interleaved CSS and SCSS parsers retain independent dialect identities", () => {
  const source = '.a { content: "#{$color}"; --value: #{$color}; }';
  const cssParser = new Parser();
  const scssParser = new Parser();
  for (let i = 0; i < 4; i++) {
    const cssTree = parse(source, cssParser);
    const scssTree = parse(source, scssParser, undefined, Scss);
    assert.equal(texts(cssTree, "interpolation").length, 0);
    assert.equal(texts(scssTree, "interpolation").length, 2);
    assert.equal(texts(cssTree, "property_declaration").length, 2);
  }
});

test("CSS literal incremental edits agree with fresh trees", () => {
  for (const [before, after] of [
    ['"#{text"', '"#{text}"'],
    ["/* #{text */", "/* #{text} */"],
    ["#{name: value}", '#{map.get($map, "key")}']
  ]) {
    const source = `.a { --value: ${before}; color: red; }`;
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
    assert.equal(parse(edited, parser, tree).rootNode.toString(), parse(edited).rootNode.toString());
  }
});

test("CSS value words stay constants while query words stay operators", () => {
  const source = String.raw`@media NOT screen and ((width > 1px) OR (height > 1px)) {
    .a { animation-name: not, true, null; value: ordinary(and, tr\75 e, n\75 ll), (or false), var(--x, not); }
  } @supports Not (display: grid) AND (color: red) {}`;
  const tree = parse(source);
  const query = new Parser.Query(Scss.cssLanguage, Scss.HIGHLIGHTS_QUERY);
  assert.deepEqual(texts(tree, "boolean"), []);
  assert.deepEqual(texts(tree, "null"), []);
  const operators = query.captures(tree.rootNode).filter(capture => capture.name === "operator");
  assert.deepEqual(
    operators.map(({ node }) => node.text),
    ["NOT", "and", ">", "OR", ">", "Not", "AND"]
  );
  for (const declaration of tree.rootNode.descendantsOfType("property_declaration")) {
    assert.equal(declaration.descendantsOfType("operator").length, 0);
    for (const value of declaration.descendantsOfType("plain_value")) {
      assert.ok(query.captures(value).some(capture => capture.name === "constant"));
    }
  }
});

test("dialect word classification preserves full identifier and interpolation boundaries", () => {
  const source = String.raw`.a { value: true, tr\75 e, false, null, n\75 ll, not, and, or, trueish, nullish, notebook, TRUE; }`;
  const parser = new Parser();
  parser.setLanguage(Scss);
  const sassTree = parser.parse(source);
  assert.equal(sassTree.rootNode.hasError, false);
  assert.deepEqual(texts(sassTree, "boolean"), ["true", "false"]);
  assert.deepEqual(texts(sassTree, "null"), ["null"]);
  assert.deepEqual(texts(sassTree, "operator"), ["not", "and", "or"]);
  for (const word of [String.raw`tr\75 e`, String.raw`n\75 ll`, "trueish", "nullish", "notebook", "TRUE"])
    assert.ok(texts(sassTree, "plain_value").includes(word));
  const cssTree = parse(source);
  assert.equal(texts(cssTree, "plain_value").length, 12);
});
