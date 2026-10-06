const assert = require("node:assert/strict");
const { test } = require("node:test");
const Parser = require("tree-sitter");
const Scss = require("./index.js");
const { effectiveCaptures } = require("./highlight_roles.js");

function propertyNames(condition, language, query) {
  const parser = new Parser();
  parser.setLanguage(language);
  const tree = parser.parse(`@media (${condition}) {} .after {}`);
  assert.equal(tree.rootNode.hasError, false, `${condition}\n${tree.rootNode}`);
  assert.equal(tree.rootNode.lastNamedChild.text, ".after {}");
  return effectiveCaptures(query, tree.rootNode)
    .filter(capture => capture.name === "property")
    .map(capture => capture.node.text);
}

// Comment-tolerant patterns cost most of the query's compile time, so a comment after `(` or a sign, or beside the name, drops the role.
test("boolean query features take the property role only beside their parentheses", () => {
  for (const language of [Scss, Scss.cssLanguage]) {
    const query = new Parser.Query(language, Scss.HIGHLIGHTS_QUERY);
    assert.deepEqual(propertyNames("color", language, query), ["color"]);
    for (const condition of ["/* note */ color", "color /* note */", "// note\ncolor"]) {
      assert.deepEqual(propertyNames(condition, language, query), [], condition);
    }
  }
});

test("range query features retain unary signs and compound left values", () => {
  for (const language of [Scss, Scss.cssLanguage]) {
    const query = new Parser.Query(language, Scss.HIGHLIGHTS_QUERY);
    for (const condition of [
      "width > 1px",
      "1px < width",
      "- 1px < width",
      "+1px < width",
      "+ - +1px < width",
      "+ $size < width",
      "#{size} < width",
      "math.min(1px, 2px) < width",
      "theme.$size < width",
      "1px < width < 10px",
      "not (width > 1px)"
    ]) {
      assert.deepEqual(propertyNames(condition, language, query), ["width"], condition);
    }
    assert.deepEqual(propertyNames("1 / 2 < aspect-ratio", language, query), ["aspect-ratio"]);
    assert.deepEqual(propertyNames("1px /* c */ < width", language, query), ["width"]);
    for (const condition of [
      "width /* c */ > 1px",
      "/* c */ 1px < width",
      "- /* c */ 1px < width",
      "1px < /* c */ width"
    ]) {
      assert.deepEqual(propertyNames(condition, language, query), [], condition);
    }
  }
});

test("query feature captures exclude unrelated words and comparison values", () => {
  for (const language of [Scss, Scss.cssLanguage]) {
    const query = new Parser.Query(language, Scss.HIGHLIGHTS_QUERY);
    for (const condition of [
      "color /**/ foo",
      "color foo /**/",
      "color /**/ foo /**/",
      "color /**/ /**/ foo /**/ /**/",
      "- < width"
    ]) {
      assert.deepEqual(propertyNames(condition, language, query), [], condition);
    }
    for (const [condition, expected] of [
      ["orientation = landscape", "orientation"],
      ["width < height", "width"],
      ["width > var(--x)", "width"]
    ]) {
      assert.deepEqual(propertyNames(condition, language, query), [expected], condition);
    }
  }
});

test("nested query groups capture only the innermost feature name", () => {
  for (const language of [Scss, Scss.cssLanguage]) {
    const query = new Parser.Query(language, Scss.HIGHLIGHTS_QUERY);
    for (const depth of [1, 32, 128]) {
      for (const condition of ["color", "width > 1px", "1px < width"]) {
        assert.deepEqual(propertyNames("(".repeat(depth) + condition + ")".repeat(depth), language, query), [
          condition.startsWith("color") ? "color" : "width"
        ]);
      }
    }
  }
});

// Emacs applies the overrides section after the base section and maps every capture name to a face.
test("the highlight query keeps one overrides section and a closed capture vocabulary", () => {
  const sections = Scss.HIGHLIGHTS_QUERY.split(/^; Context overrides\n/m);
  assert.equal(sections.length, 2);
  for (const language of [Scss, Scss.cssLanguage]) {
    for (const section of sections) new Parser.Query(language, section);
  }
  const names = [...Scss.HIGHLIGHTS_QUERY.matchAll(/"(?:[^"\\]|\\.)*"|@([\w.-]+)/g)]
    .map(match => match[1])
    .filter(Boolean);
  assert.deepEqual([...new Set(names)].sort(), [
    "attribute",
    "comment",
    "constant",
    "constant.builtin",
    "function",
    "keyword",
    "keyword.conditional",
    "keyword.debug",
    "keyword.directive",
    "keyword.exception",
    "keyword.import",
    "keyword.modifier",
    "keyword.repeat",
    "keyword.return",
    "module",
    "number",
    "operator",
    "operator.expression",
    "property",
    "punctuation.bracket",
    "punctuation.delimiter",
    "punctuation.special",
    "string",
    "string.escape",
    "tag",
    "type",
    "type.unit",
    "variable",
    "variable.parameter"
  ]);
});

function roleAt(source, captures, text, offset = 0) {
  const position = source.indexOf(text) + offset;
  assert.ok(source.includes(text), text);
  return captures
    .filter(({ node }) => node.startIndex <= position && position < node.endIndex)
    .sort((a, b) => a.node.endIndex - a.node.startIndex - (b.node.endIndex - b.node.startIndex))[0]?.name;
}

test("selector prefixes share their name role without overriding other dots", () => {
  const source =
    'theme.$gap: 1px; %base, .card#main::before, :not(.muted), .x:lang(en.*), [data-x="a"] { @include theme.card; x: math.max(theme.$gap, foo.bar); }';
  const parser = new Parser();
  parser.setLanguage(Scss);
  const tree = parser.parse(source);
  assert.equal(tree.rootNode.hasError, false);
  const captures = effectiveCaptures(new Parser.Query(Scss, Scss.HIGHLIGHTS_QUERY), tree.rootNode);
  for (const text of ["%base", ".card", "#main", "::before", ":not", ".muted"]) {
    assert.equal(roleAt(source, captures, text), "attribute", text);
  }
  for (const [text, offset] of [
    ["theme.$gap", 5],
    ["theme.card", 5],
    ["math.max", 4],
    ["foo.bar", 3],
    ["en.*", 2]
  ]) {
    assert.equal(roleAt(source, captures, text, offset), "punctuation.delimiter", text);
  }
  assert.equal(roleAt(source, captures, '"a"'), "string");
});

test("colons and semicolons stay uncaptured outside pseudo-classes", () => {
  const source = "$m: (a: 1); .a:hover { color: fn($x: 1); }";
  const parser = new Parser();
  parser.setLanguage(Scss);
  const tree = parser.parse(source);
  assert.equal(tree.rootNode.hasError, false);
  const captures = effectiveCaptures(new Parser.Query(Scss, Scss.HIGHLIGHTS_QUERY), tree.rootNode);
  for (const [text, offset] of [
    ["$m:", 2],
    ["a:", 1],
    ["1);", 2],
    ["color:", 5],
    ["$x:", 2],
    ["1); }", 2]
  ]) {
    assert.equal(roleAt(source, captures, text, offset), undefined, text);
  }
  assert.equal(roleAt(source, captures, ":hover"), "attribute");
});

test("value operators and units have sub-roles while query and type operators stay structural", () => {
  for (const language of [Scss, Scss.cssLanguage]) {
    const source =
      "@media not screen and (width > 10px) { .a > .b { width: calc(100% - 2rem); } } @function --f(--n <length>+) returns <length> { result: 1px; }";
    const parser = new Parser();
    parser.setLanguage(language);
    const tree = parser.parse(source);
    assert.equal(tree.rootNode.hasError, false);
    const captures = effectiveCaptures(new Parser.Query(language, Scss.HIGHLIGHTS_QUERY), tree.rootNode);
    assert.equal(roleAt(source, captures, "10px", 2), "type.unit");
    assert.equal(roleAt(source, captures, "100%", 3), "type.unit");
    assert.equal(roleAt(source, captures, " - ", 1), "operator.expression");
    for (const [text, offset] of [
      ["not", 0],
      ["and", 0],
      ["width >", 6],
      [".a >", 3],
      ["length>+", 7]
    ]) {
      assert.equal(roleAt(source, captures, text, offset), "operator", text);
    }
    assert.equal(roleAt(source, captures, "length"), "type");
    const numeric = tree.rootNode.descendantsOfType("number").find(node => node.text === "10px");
    assert.equal(numeric.namedChildren[0].type, "unit");
    assert.equal(numeric.namedChildren[0].text, "px");
  }
});

// tree-sitter-highlight matches theme names by parts, so a sub-role naming another role would take that role's color.
test("capture sub-roles never reuse a top-level role name", () => {
  const names = new Set(
    [...Scss.HIGHLIGHTS_QUERY.matchAll(/"(?:[^"\\]|\\.)*"|@([\w.-]+)/g)].map(match => match[1]).filter(Boolean)
  );
  const roles = new Set([...names].map(name => name.split(".")[0]));
  for (const name of names) {
    for (const part of name.split(".").slice(1)) assert.ok(!roles.has(part), `${name} would resolve to ${part}`);
  }
});
