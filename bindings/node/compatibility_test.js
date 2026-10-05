const assert = require("node:assert/strict");
const { test } = require("node:test");
const Parser = require("tree-sitter");
const Scss = require("./index.js");

const queries = new Map(
  [Scss, Scss.cssLanguage].map(language => [language, new Parser.Query(language, Scss.HIGHLIGHTS_QUERY)])
);

// dart-sass parses each accepted Sass form here and reports a syntax error for each rejected one.
function parse(source, language = Scss) {
  const parser = new Parser();
  parser.setLanguage(language);
  const tree = parser.parse(source);
  assert.equal(tree.rootNode.hasError, false, `${source}\n${tree.rootNode}`);
  return { tree, captures: queries.get(language).captures(tree.rootNode) };
}

function hasError(source, language = Scss) {
  const parser = new Parser();
  parser.setLanguage(language);
  return parser.parse(source).rootNode.hasError;
}

function texts(tree, type) {
  return tree.rootNode.descendantsOfType(type).map(node => node.text);
}

function role(captures, text, expected, excluded) {
  const names = captures.filter(capture => capture.node.text === text).map(capture => capture.name);
  assert.ok(names.includes(expected), `${text}: expected ${expected}, got ${names}`);
  if (excluded) assert.ok(!names.includes(excluded), `${text}: unexpected ${excluded}`);
}

test("keyword-shaped mixin names remain include targets", () => {
  for (const language of [Scss, Scss.cssLanguage]) {
    for (const name of ["media", "calc", "min", "url", "selector", "supports", "style", "element", "expression"]) {
      for (const other of ["result", "else", "if", "IF", "not", "true", "null"]) {
        const source = `.a { @include ${name}(">phone") { b: c; } @include theme.${other}; } .after {}`;
        const { tree, captures } = parse(source, language);
        const includes = tree.rootNode.descendantsOfType("include_statement");
        assert.deepEqual(
          includes.map(node => node.childForFieldName("name").text),
          [name, other]
        );
        assert.equal(includes[1].childForFieldName("module").text, "theme");
        assert.equal(tree.rootNode.lastNamedChild.text, ".after {}");
        role(captures, name, "function");
        role(captures, other, "function");
      }
    }
  }
});

test("boolean and null names remain callable without changing literal values", () => {
  for (const language of [Scss, Scss.cssLanguage]) {
    for (const name of ["true", "false", "null"]) {
      const { tree, captures } = parse(
        `@function ${name}($value: red) { @return $value; } .a { a: ${name}(); b: ${name}($value: red); c: wrap(${name}(red)); d: ${name}; e: ${name} (1); } .after {}`,
        language
      );
      const calls = tree.rootNode.descendantsOfType("call_expression");
      assert.deepEqual(
        calls.map(node => node.childForFieldName("name").text),
        [name, name, "wrap", name]
      );
      assert.equal(calls[1].childForFieldName("arguments").firstNamedChild.type, "named_argument");
      const declarations = tree.rootNode.descendantsOfType("property_declaration");
      const literalType = language === Scss ? (name === "null" ? "null" : "boolean") : "plain_value";
      assert.equal(declarations[3].childForFieldName("value").type, literalType);
      assert.deepEqual(
        declarations[4].childrenForFieldName("value").map(node => node.type),
        [literalType, "list"]
      );
      for (const call of calls) {
        const callee = call.childForFieldName("name");
        assert.deepEqual(
          captures.filter(capture => capture.node.id === callee.id).map(capture => capture.name),
          ["function"]
        );
      }
      assert.equal(tree.rootNode.lastNamedChild.text, ".after {}");
    }
  }
});

test("include arguments may follow whitespace", () => {
  for (const language of [Scss, Scss.cssLanguage]) {
    const { tree } = parse(
      ".a { @include ring (1px, $size: 2px); @include theme.ring () { b: c; } } .after {}",
      language
    );
    assert.deepEqual(
      tree.rootNode.descendantsOfType("include_statement").map(node => node.childForFieldName("arguments").text),
      ["(1px, $size: 2px)", "()"]
    );
    assert.equal(tree.rootNode.lastNamedChild.text, ".after {}");
  }
});

test("semicolon-terminated statements may end at a closing brace or the end of input", () => {
  for (const language of [Scss, Scss.cssLanguage]) {
    for (const [source, type] of [
      [".a { @include ring }", "include_statement"],
      [".a { @include ring(1) }", "include_statement"],
      [".a { @include ring /* note */ }", "include_statement"],
      ["@mixin m { @content }", "content_statement"],
      ["@mixin m { @content(1) }", "content_statement"],
      [".a { @extend .b !optional }", "extend_statement"],
      ["@function f() { @return 1 }", "value_statement"],
      [".a { @debug 1 }", "value_statement"],
      [".a { @apply font-bold }", "at_rule"],
      [".a { @layer base }", "css_statement"],
      ['.a { @import "x.css" }', "query_statement"],
      [".a { $x: 1 }", "variable_declaration"]
    ]) {
      const { tree } = parse(`${source} .after {}`, language);
      assert.equal(tree.rootNode.descendantsOfType(type).length, 1, source);
      assert.equal(tree.rootNode.lastNamedChild.text, ".after {}");
    }
    for (const [source, type] of [
      ['@use "x"', "use_statement"],
      ['@forward "x" show y', "forward_statement"],
      ["@include ring", "include_statement"],
      ["@debug 1", "value_statement"],
      ['@charset "UTF-8"', "css_statement"],
      ['@import "a", "b"', "query_statement"],
      ["@namespace svg url(x)", "namespace_statement"],
      ["@apply font-bold", "at_rule"],
      ["$x: 1", "variable_declaration"],
      ["lib.$x: 1", "variable_declaration"]
    ]) {
      // Sass module rules must precede style rules.
      const prefix = /^@(?:use|forward)\b/.test(source) ? '@use "y";' : ".before {}";
      const { tree } = parse(`${prefix} ${source}`, language);
      assert.equal(tree.rootNode.lastNamedChild.type, type, source);
      assert.equal(tree.rootNode.lastNamedChild.text, source);
    }
  }
});

test("a spaced dot cannot hide a missing semicolon before a nested rule", () => {
  for (const language of [Scss, Scss.cssLanguage]) {
    for (const source of [
      ".a { color: red\n  .b { x: y; } } .after {}",
      ".a { color: red .b {} } .after {}",
      "$x: a .b; .after {}",
      "$x: math .div(1, 2); .after {}",
      "$x: theme .$gap; .after {}"
    ]) {
      assert.equal(hasError(source, language), true, source);
    }
    const { tree } = parse("@layer framework.base; $x: math.div(1, 2) theme.$gap; .after {}", language);
    assert.deepEqual(texts(tree, "dotted_value"), ["framework.base"]);
    assert.deepEqual(texts(tree, "member_expression"), ["theme.$gap"]);
    assert.deepEqual(texts(tree, "module_name"), ["math", "theme"]);
  }
});

test("module variable assignments keep compound selectors distinct", () => {
  for (const language of [Scss, Scss.cssLanguage]) {
    const { tree, captures } = parse(
      "lib.$color: blue !default; .a { theme.$gap: 1px; a.b {} div.c#d {} } math.red#if {}",
      language
    );
    const declarations = tree.rootNode.descendantsOfType("variable_declaration");
    assert.deepEqual(
      declarations.map(node => [node.childForFieldName("module").text, node.childForFieldName("name").text]),
      [
        ["lib", "$color"],
        ["theme", "$gap"]
      ]
    );
    assert.deepEqual(
      declarations[0].childrenForFieldName("flags").map(node => node.text),
      ["!default"]
    );
    assert.deepEqual(texts(tree, "selectors").slice(1), ["a.b", "div.c#d", "math.red#if"]);
    role(captures, "lib", "module");
    role(captures, "$color", "variable");
    role(captures, "a", "tag", "module");
  }
});

test("special call names are ordinary words unless their call syntax follows", () => {
  for (const language of [Scss, Scss.cssLanguage]) {
    const { tree, captures } = parse(
      "$types: text url color; $m: (url: 1, element: 2, expression: 3, -moz-element: 4); .a { b: url(a.png) element(#c) URL; } .after {}",
      language
    );
    assert.deepEqual(texts(tree, "plain_value"), [
      "text",
      "url",
      "color",
      "url",
      "element",
      "expression",
      "-moz-element",
      "URL"
    ]);
    assert.deepEqual(texts(tree, "url"), ["url(a.png)"]);
    assert.deepEqual(texts(tree, "special_call"), ["element(#c)"]);
    assert.equal(tree.rootNode.lastNamedChild.text, ".after {}");
    role(captures, "URL", "constant", "function");
  }
  const { tree } = parse(".a { b: url#{$x}; }");
  assert.deepEqual(texts(tree, "plain_value"), ["url#{$x}"]);
});

test("dashed query features may stand alone or start a range", () => {
  for (const language of [Scss, Scss.cssLanguage]) {
    for (const source of [
      "@container style(--responsive) { .a { b: c; } }",
      "@container style(--x > 10) and style(--y) {}",
      "@media (--small) and (--x > 10px) {}",
      "@media not (--small) {}",
      "@supports (--x) {}"
    ]) {
      const { tree } = parse(`${source} .after {}`, language);
      assert.equal(tree.rootNode.descendantsOfType("feature_query").length, 0, source);
      assert.equal(tree.rootNode.lastNamedChild.text, ".after {}");
    }
    const { captures } = parse("@media (--small) and (--x > 10px) {}", language);
    role(captures, "--small", "property");
    role(captures, "--x", "property");
    const declaration = parse("@container style(--x: a) {}", language).tree;
    assert.equal(declaration.rootNode.descendantsOfType("feature_query")[0].text, "--x: a");
  }
});

test("mixin, function, and url() arguments follow Sass argument rules", () => {
  const { tree } = parse(
    "@mixin m { @content($b: 2, $rest...); } .a { background: url(fn($u)) url(map-get($m, a)) url(a.png); }"
  );
  assert.deepEqual(texts(tree, "named_argument"), ["$b: 2"]);
  const urls = tree.rootNode.descendantsOfType("url");
  assert.deepEqual(
    urls.map(node => node.namedChildren[1].type),
    ["call_expression", "call_expression", "url_value"]
  );
  assert.deepEqual(
    urls.slice(0, 2).map(node => node.namedChildren[1].childForFieldName("name").text),
    ["fn", "map-get"]
  );
  for (const source of [".a { @include m(a=b); }", ".a { x: a=b; }"]) {
    assert.equal(hasError(source), true, source);
  }
});

test("deprecated @elseif clauses stay attached to their @if", () => {
  const { tree, captures } = parse("@if $a { .a {} } @elseif $b { .b {} } @else { .c {} } .after {}");
  const statement = tree.rootNode.firstNamedChild;
  assert.equal(statement.type, "if_statement");
  assert.deepEqual(
    statement.namedChildren
      .filter(node => node.type === "else_clause")
      .map(node => node.childForFieldName("condition")?.text ?? null),
    ["$b", null]
  );
  assert.equal(tree.rootNode.lastNamedChild.text, ".after {}");
  role(captures, "@elseif", "keyword.conditional");
});

test("interpolation continues a name only when it is adjacent", () => {
  for (const language of [Scss, Scss.cssLanguage]) {
    const { tree } = parse(
      ".a { b: bold #{$s}; c: #{$a}#{$b} #{$c}; d: calc(#{$x} - #{$y}); e: a-#{$f}; } .w #{$v} {} @x #{$y}; .after {}",
      language
    );
    const values = tree.rootNode
      .descendantsOfType("property_declaration")
      .map(node => node.namedChildren.slice(1).map(child => [child.type, child.text]));
    assert.deepEqual(values, [
      [
        ["plain_value", "bold"],
        ["interpolation", "#{$s}"]
      ],
      [
        ["plain_value", "#{$a}#{$b}"],
        ["interpolation", "#{$c}"]
      ],
      [["call_expression", "calc(#{$x} - #{$y})"]],
      [["plain_value", "a-#{$f}"]]
    ]);
    assert.deepEqual(texts(tree, "operator"), ["-"]);
    assert.deepEqual(
      tree.rootNode.children[1]
        .childForFieldName("selectors")
        .firstNamedChild.namedChildren.map(node => [node.type, node.text]),
      [
        ["class_selector", ".w"],
        ["tag_selector", "#{$v}"]
      ]
    );
    assert.deepEqual(texts(tree, "at_keyword"), ["@x"]);
    assert.equal(tree.rootNode.lastNamedChild.text, ".after {}");
  }
});

test("incremental edits across compatibility boundaries agree with fresh parses", () => {
  for (const language of [Scss, Scss.cssLanguage]) {
    const query = queries.get(language);
    for (const [before, after] of [
      [".a { @include ring; } .after {}", ".a { @include ring } .after {}"],
      [".a { @include ring(1); } .after {}", ".a { @include ring (1); } .after {}"],
      [".a { @include ring; } .after {}", ".a { @include media; } .after {}"],
      ["$x: url; .after {}", "$x: url(a); .after {}"],
      ["$x: true; .after {}", "$x: true(); .after {}"],
      ["$x: false(); .after {}", "$x: false; .after {}"],
      ["$x: null (1); .after {}", "$x: null(1); .after {}"],
      ["$x: true(1); .after {}", "$x: true($value: 1); .after {}"],
      ["a.b {} .after {}", "a.$b: 1; .after {}"],
      ["@media (color) {} .after {}", "@media (--color) {} .after {}"],
      ["@if $a {} @else if $b {} .after {}", "@if $a {} @elseif $b {} .after {}"],
      [".a { b: bold#{$s}; } .after {}", ".a { b: bold #{$s}; } .after {}"],
      [".w#{$v} {} .after {}", ".w #{$v} {} .after {}"],
      ["@media screen {} .after {}", String.raw`@m\65 dia screen {} .after {}`],
      [String.raw`@m\65 dia screen {} .after {}`, String.raw`@m\65dia screen {} .after {}`],
      // CSS keeps url() contents literal, so only Sass reparses them as a call.
      ...(language === Scss ? [[".a { b: url(a.png); } .after {}", ".a { b: url(a(b)); } .after {}"]] : [])
    ]) {
      const parser = new Parser();
      parser.setLanguage(language);
      const tree = parser.parse(before);
      let start = 0;
      while (before[start] === after[start]) start++;
      let oldEnd = before.length;
      let newEnd = after.length;
      while (oldEnd > start && newEnd > start && before[oldEnd - 1] === after[newEnd - 1]) {
        oldEnd--;
        newEnd--;
      }
      tree.edit({
        startIndex: start,
        oldEndIndex: oldEnd,
        newEndIndex: newEnd,
        startPosition: { row: 0, column: start },
        oldEndPosition: { row: 0, column: oldEnd },
        newEndPosition: { row: 0, column: newEnd }
      });
      const incremental = parser.parse(after, tree);
      const fresh = parse(after, language).tree;
      assert.equal(incremental.rootNode.toString(), fresh.rootNode.toString(), `${before} → ${after}`);
      const captures = current =>
        query.captures(current.rootNode).map(({ name, node }) => [name, node.startIndex, node.endIndex]);
      assert.deepEqual(captures(incremental), captures(fresh));
    }
  }
});
