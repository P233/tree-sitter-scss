const assert = require("node:assert/strict");
const { test } = require("node:test");
const Parser = require("tree-sitter");
const Scss = require("./index.js");

function parse(source, language = Scss) {
  const parser = new Parser();
  parser.setLanguage(language);
  const root = parser.parse(source).rootNode;
  assert.equal(root.hasError, false, root.toString());
  return root;
}

function children(node, type) {
  return node.namedChildren.filter(child => child.type === type);
}

function fieldTexts(node, field) {
  return node.childrenForFieldName(field).map(child => child.text);
}

test("body and selector fields preserve empty blocks and trivia boundaries", () => {
  for (const language of [Scss, Scss.cssLanguage]) {
    const root = parse(".a, .b { color: red; } .empty {} .comments { /* only */ }", language);
    const [populated, empty, comments] = root.namedChildren;
    assert.deepEqual(fieldTexts(populated, "selectors"), [".a, .b"]);
    assert.deepEqual(fieldTexts(populated, "body"), ["color: red;"]);
    for (const rule of [empty, comments]) {
      assert.equal(rule.childForFieldName("body"), null);
      assert.deepEqual(
        rule.children.filter(child => !child.isNamed).map(child => child.text),
        ["{", "}"]
      );
    }
    assert.equal(comments.descendantsOfType("block_comment")[0].text, "/* only */");
  }
});

test("value fields keep ordered components apart from flags and trivia", () => {
  for (const language of [Scss, Scss.cssLanguage]) {
    const root = parse(
      ".a { color: red /* inner */ blue, green !important; --raw: { a:b; } !important; empty:; }",
      language
    );
    const [value, raw, empty] = root.descendantsOfType("property_declaration");
    assert.deepEqual(fieldTexts(value, "value"), ["red", "blue", ",", "green"]);
    assert.deepEqual(fieldTexts(value, "flags"), ["!important"]);
    assert.deepEqual(fieldTexts(raw, "value"), ["{ a:b; }"]);
    assert.deepEqual(fieldTexts(raw, "flags"), ["!important"]);
    assert.deepEqual(fieldTexts(empty, "value"), []);
    assert.deepEqual(fieldTexts(empty, "flags"), []);
  }
  const root = parse("$x: 1 2, 3 !default !global; .a { font: bold { size: 1rem; } }");
  assert.deepEqual(fieldTexts(root.firstNamedChild, "value"), ["1", "2", ",", "3"]);
  assert.deepEqual(fieldTexts(root.firstNamedChild, "flags"), ["!default", "!global"]);
  const nested = root.descendantsOfType("nested_property")[0];
  assert.equal(nested.parent.type, "property_declaration");
  assert.equal(nested.parent.childForFieldName("name"), null);
  assert.deepEqual(fieldTexts(nested, "name"), ["font"]);
  assert.deepEqual(fieldTexts(nested, "value"), ["bold"]);
  assert.deepEqual(fieldTexts(nested, "body"), ["size: 1rem;"]);
});

test("prelude and condition fields cannot include their bodies or dependent branches", () => {
  for (const language of [Scss, Scss.cssLanguage]) {
    const root = parse("@media screen and (width > 1px), print { .a {} } @future foo(bar) [x] { .b {} }", language);
    assert.deepEqual(fieldTexts(root.firstNamedChild, "prelude"), ["screen", "and", "(width > 1px)", ",", "print"]);
    assert.deepEqual(fieldTexts(root.firstNamedChild, "body"), [".a {}"]);
    assert.deepEqual(fieldTexts(root.lastNamedChild, "prelude"), ["foo(bar)", "[x]"]);
    assert.deepEqual(fieldTexts(root.lastNamedChild, "body"), [".b {}"]);
    const branchRoot = parse(".a { color: if(media(width > 1px): red, blue; else:); }", language);
    const [condition, fallback] = branchRoot.descendantsOfType("conditional_branch");
    assert.deepEqual(fieldTexts(condition, "condition"), ["media(width > 1px)"]);
    assert.deepEqual(fieldTexts(condition, "value"), ["red", ",", "blue"]);
    assert.deepEqual(fieldTexts(fallback, "condition"), ["else"]);
    assert.deepEqual(fieldTexts(fallback, "value"), []);
  }
  const statement = parse("@if $x > 1 { .a {} } @else if false { .b {} } @else {}").firstNamedChild;
  assert.deepEqual(fieldTexts(statement, "condition"), ["$x", ">", "1"]);
  assert.deepEqual(fieldTexts(statement, "body"), [".a {}"]);
  const [conditional, fallback] = children(statement, "else_clause");
  assert.deepEqual(fieldTexts(conditional, "condition"), ["false"]);
  assert.deepEqual(fieldTexts(conditional, "body"), [".b {}"]);
  assert.deepEqual(fieldTexts(fallback, "condition"), []);
  assert.deepEqual(fieldTexts(fallback, "body"), []);
});

test("callable fields distinguish module names, parameters, arguments and defaults", () => {
  const root = parse(
    '@use "tokens" as theme; @mixin demo($x: 1 2, $rest...) {} @include theme.demo($x: 1 2) using ($y) { color:red; } .a { x: theme.$tone; y: theme.double(1); }'
  );
  assert.deepEqual(fieldTexts(root.firstNamedChild, "alias"), ["theme"]);
  const definition = root.descendantsOfType("mixin_definition")[0];
  assert.deepEqual(fieldTexts(definition, "parameters"), ["($x: 1 2, $rest...)"]);
  const [parameter, rest] = definition.descendantsOfType("parameter");
  assert.deepEqual(fieldTexts(parameter, "name"), ["$x"]);
  assert.deepEqual(fieldTexts(parameter, "value"), ["1", "2"]);
  assert.deepEqual(fieldTexts(rest, "value"), []);
  const include = root.descendantsOfType("include_statement")[0];
  assert.deepEqual(fieldTexts(include, "module"), ["theme"]);
  assert.deepEqual(fieldTexts(include, "name"), ["demo"]);
  assert.deepEqual(fieldTexts(include, "arguments"), ["($x: 1 2)"]);
  assert.deepEqual(fieldTexts(include, "parameters"), ["($y)"]);
  assert.deepEqual(fieldTexts(include, "body"), ["color:red;"]);
  assert.deepEqual(fieldTexts(include.descendantsOfType("named_argument")[0], "value"), ["1", "2"]);
  const member = root.descendantsOfType("member_expression")[0];
  assert.deepEqual(fieldTexts(member, "module"), ["theme"]);
  assert.deepEqual(fieldTexts(member, "name"), ["$tone"]);
  const call = root.descendantsOfType("call_expression")[0];
  assert.deepEqual(fieldTexts(call, "module"), ["theme"]);
  assert.deepEqual(fieldTexts(call, "arguments"), ["(1)"]);
  for (const language of [Scss, Scss.cssLanguage]) {
    const definition = parse(
      "@function --scale(--size <length>: 1px) returns <length> { result: 1px !important; }",
      language
    ).firstNamedChild;
    assert.deepEqual(fieldTexts(definition, "parameters"), ["(--size <length>: 1px)"]);
    assert.deepEqual(fieldTexts(definition.descendantsOfType("parameter")[0], "name"), ["--size"]);
    assert.deepEqual(fieldTexts(definition.descendantsOfType("property_declaration")[0], "value"), ["1px"]);
  }
});

test("rule, declaration and nested-property bodies keep their own sibling boundaries", () => {
  const root = parse(".a, .b:hover { font: bold { size: 1rem; } color: red; &:hover { opacity: 1 } } .after {}");
  assert.deepEqual(
    root.namedChildren.map(node => node.type),
    ["rule_set", "rule_set"]
  );
  const rule = root.firstNamedChild;
  const body = children(rule, "declaration_block")[0];
  assert.equal(children(rule, "selectors")[0].text, ".a, .b:hover");
  assert.deepEqual(
    body.namedChildren.map(node => node.type),
    ["property_declaration", "property_declaration", "rule_set"]
  );
  const nested = body.firstNamedChild.firstNamedChild;
  assert.equal(nested.type, "nested_property");
  assert.equal(nested.childForFieldName("name").text, "font");
  assert.equal(children(nested, "declaration_block")[0].text, "size: 1rem;");
  assert.equal(body.namedChildren[1].childForFieldName("name").text, "color");
  assert.equal(root.lastNamedChild.text, ".after {}");
});

test("unknown at-rules and raw values do not consume enclosing or following blocks", () => {
  for (const language of [Scss, Scss.cssLanguage]) {
    const root = parse(
      '@unknown token(foo: [bar]) { .a { --raw: { nested: ["}", ";"] }; color: red; } .b {} } .after {}',
      language
    );
    assert.deepEqual(
      root.namedChildren.map(node => node.type),
      ["at_rule", "rule_set"]
    );
    const body = children(root.firstNamedChild, "declaration_block")[0];
    assert.deepEqual(
      body.namedChildren.map(node => node.type),
      ["rule_set", "rule_set"]
    );
    const declarations = children(body.firstNamedChild, "declaration_block")[0];
    assert.deepEqual(
      declarations.namedChildren.map(node => node.childForFieldName("name").text),
      ["--raw", "color"]
    );
    assert.equal(root.lastNamedChild.text, ".after {}");
  }
});

test("dependent else clauses stay attached while following statements remain siblings", () => {
  const root = parse("@if true { .a {} } @else if false { .b {} } @else { .c {} } .after {}");
  assert.deepEqual(
    root.namedChildren.map(node => node.type),
    ["if_statement", "rule_set"]
  );
  assert.equal(children(root.firstNamedChild, "else_clause").length, 2);
  assert.equal(root.lastNamedChild.text, ".after {}");
});

test("query groups and features have identities distinct from Sass value containers", () => {
  for (const language of [Scss, Scss.cssLanguage]) {
    const root = parse(
      "@supports ((display: grid) and (color: red)) { .a {} } @media (400px < width < 1000px) {} .after {}",
      language
    );
    assert.deepEqual(
      root.namedChildren.map(node => node.type),
      ["query_statement", "query_statement", "rule_set"]
    );
    assert.equal(root.descendantsOfType("query_group").length, 4);
    assert.equal(root.descendantsOfType(["map", "map_entry", "list"]).length, 0);
    assert.deepEqual(
      root.descendantsOfType("feature_query").map(node => node.childForFieldName("name").text),
      ["display", "color"]
    );
    assert.equal(root.lastNamedChild.text, ".after {}");
  }
});

test("Sass expressions inside query features keep their ordinary value structure", () => {
  const root = parse("$map: (a: b); .a { value: (a: b); } @media (min-width: map.get($breakpoints, small)) { .b {} }");
  assert.equal(root.descendantsOfType("map").length, 2);
  assert.equal(root.descendantsOfType("query_group").length, 1);
  const feature = root.descendantsOfType("feature_query")[0];
  assert.equal(feature.childForFieldName("name").text, "min-width");
  assert.equal(feature.descendantsOfType("call_expression")[0].text, "map.get($breakpoints, small)");
});

test("query equality belongs to the condition and preserves its body", () => {
  for (const language of [Scss, Scss.cssLanguage]) {
    for (const directive of ["media", "container"]) {
      const root = parse(`@${directive} (width = 40rem) { .a { color: red; } } .after {}`, language);
      const group = root.descendantsOfType("query_group")[0];
      assert.equal(group.descendantsOfType("operator")[0].text, "=");
      assert.equal(root.lastNamedChild.text, ".after {}");
    }
  }
});

test("query declarations own their complete comma and raw values", () => {
  for (const language of [Scss, Scss.cssLanguage]) {
    for (const [source, name, value] of [
      ["@supports (font-family: foo, bar) {}", "font-family", "foo, bar"],
      ["@supports (--x: { a:b; }) {}", "--x", "{ a:b; }"],
      ["@container style(--x: a,b) {}", "--x", "a,b"],
      ["@container style(--x: [a;b]) {}", "--x", "[a;b]"],
      ['@import "x.css" supports(font-family: a,b) screen;', "font-family", "a,b"]
    ]) {
      const root = parse(`${source} .after {}`, language);
      const features = root.descendantsOfType("feature_query");
      assert.equal(features.length, 1, source);
      assert.equal(features[0].childForFieldName("name").text, name);
      assert.equal(features[0].text, `${name}: ${value}`);
      for (const args of root.descendantsOfType("arguments")) {
        assert.deepEqual(
          args.namedChildren.map(node => node.type),
          ["feature_query"]
        );
      }
      assert.equal(root.lastNamedChild.text, ".after {}");
    }
    const nested = parse("@container style((--x: a, b) and (--y: c)) {}", language);
    assert.equal(nested.descendantsOfType("query_group").length, 3);
    assert.equal(nested.descendantsOfType(["map", "list"]).length, 0);
  }
});

test("query function specialization preserves ordinary calls and longer names", () => {
  for (const language of [Scss, Scss.cssLanguage]) {
    const root = parse("@media stylex(foo,bar) {} .a { stylesheet: style(a,b); }", language);
    assert.deepEqual(
      root.descendantsOfType("call_expression").map(node => node.childForFieldName("name").text),
      ["stylex", "style"]
    );
    assert.deepEqual(
      root.descendantsOfType("arguments").map(node => node.namedChildCount),
      [2, 2]
    );
    assert.equal(root.descendantsOfType("property_declaration")[0].childForFieldName("name").text, "stylesheet");
  }
});

test("empty media query lists preserve empty and populated bodies", () => {
  for (const language of [Scss, Scss.cssLanguage]) {
    const root = parse("@media {} @media { .a { color: red; } } .after {}", language);
    assert.deepEqual(
      root.namedChildren.map(node => node.type),
      ["query_statement", "query_statement", "rule_set"]
    );
    assert.equal(children(root.namedChildren[1], "declaration_block")[0].text, ".a { color: red; }");
  }
});

test("unknown at-rule statements retain the enclosing block without flattening known syntax", () => {
  for (const language of [Scss, Scss.cssLanguage]) {
    const root = parse("@future { anything(a: [b; {c:d}]); color:red; [a=b] { x:y } svg|a {} } .after {}", language);
    assert.deepEqual(
      root.namedChildren.map(node => node.type),
      ["at_rule", "rule_set"]
    );
    const body = children(root.firstNamedChild, "declaration_block")[0];
    assert.deepEqual(
      body.namedChildren.map(node => node.type),
      ["raw_statement", "property_declaration", "rule_set", "rule_set"]
    );
    assert.equal(body.firstNamedChild.text, "anything(a: [b; {c:d}]);");
    assert.equal(body.namedChildren[1].childForFieldName("name").text, "color");
    assert.equal(body.descendantsOfType("attribute_selector")[0].text, "[a=b]");
    assert.equal(root.lastNamedChild.text, ".after {}");
  }
});

test("incremental query and unknown-statement edits preserve complete structure and captures", () => {
  for (const language of [Scss, Scss.cssLanguage]) {
    const query = new Parser.Query(language, Scss.HIGHLIGHTS_QUERY);
    for (const [source, from, to] of [
      ["@media (width = 10px) { .a {} } .after {}", "10px", "40rem"],
      ["@container style(--x: a,b) { .a {} } .after {}", "a,b", "[a;b]"],
      ["@future { thing(a:b); .a {} } .after {}", "a:b", 'a: ["}", b]']
    ]) {
      const parser = new Parser();
      parser.setLanguage(language);
      const previous = parser.parse(source);
      const start = source.indexOf(from);
      const changed = source.slice(0, start) + to + source.slice(start + from.length);
      previous.edit({
        startIndex: start,
        oldEndIndex: start + from.length,
        newEndIndex: start + to.length,
        startPosition: { row: 0, column: start },
        oldEndPosition: { row: 0, column: start + from.length },
        newEndPosition: { row: 0, column: start + to.length }
      });
      const incremental = parser.parse(changed, previous).rootNode;
      const fresh = parse(changed, language);
      assert.equal(incremental.hasError, false);
      assert.equal(incremental.toString(), fresh.toString());
      assert.equal(incremental.lastNamedChild.text, ".after {}");
      const captures = node => query.captures(node).map(({ name, node }) => [name, node.startIndex, node.endIndex]);
      assert.deepEqual(captures(incremental), captures(fresh));
    }
  }
});
