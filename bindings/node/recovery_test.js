const assert = require("node:assert/strict");
const { test } = require("node:test");
const Parser = require("tree-sitter");
const Scss = require("./index.js");

// Enough later rules for the runtime to settle on one recovery, as in a real file.
const tail = Array.from({ length: 300 }, (_, index) => `.t${index} { margin: ${index}px; }`).join("\n");
const errors = node => node.descendantsOfType("ERROR").map(error => error.text.trim());
const declarations = node => node.descendantsOfType("property_declaration").map(declaration => declaration.text);
const above = line => `.a {\n  ${line}\n  width: 1px;\n}\n.y {\n  color: blue;\n}\n${tail}\n`;

function eachParser(callback) {
  for (const language of [Scss, Scss.cssLanguage]) callback(new Parser().setLanguage(language), language.name);
}

test("a statement typed above a declaration ends at its own line", () => {
  eachParser((parser, dialect) => {
    for (const [line, error] of [
      ["c", "c"],
      ["m10", "m10"],
      [".b", ".b"],
      ["&-x", "&-x"],
      ["#id", "#id"],
      ["[data-x]", "[data-x]"],
      [".b:hover", ".b:hover"],
      ["&:is(.c)", "&:is(.c)"],
      ["a b", "a b"],
      [".b > .c", ".b > .c"],
      // Punctuation that cannot complete a selector line ends there; the error covers the selector before it.
      [".b,", ".b"],
      [".b >", ".b"],
      ["&:is(", "&:is"],
      ["a|b,", "a|b"],
      [".c:", ".c"],
      [".b.", ".b"],
      ["&:is(.c, .)", "&:is(.c"],
      [".b-#{", ".b-"],
      [".b-#{$}", ".b-"],
      // A line-leading combinator or interpolation is skipped as one error.
      [">", ">"],
      ["+", "+"],
      ["~", "~"],
      ["> .", "> ."],
      ["#{}", "#{}"],
      ["#{$}", "#{$}"],
      // An attribute operator before its value parses, as an editing tolerance.
      ["&[d=]", "&[d=]"],
      ["@media (", "@media ("]
    ]) {
      const root = parser.parse(above(`color: red;\n  ${line}`)).rootNode;
      assert.equal(root.namedChildCount, 302, `${dialect}: ${line}`);
      assert.deepEqual(declarations(root.firstNamedChild), ["color: red;", "width: 1px;"], `${dialect}: ${line}`);
      assert.deepEqual(errors(root.firstNamedChild), [error], `${dialect}: ${line}`);
    }
    assert.equal(parser.parse("[a=] {}").rootNode.hasError, false, dialect);
    // Comments may separate the line from a declaration of any form.
    for (const [header, declaration] of [
      [".b, // c", "width: 1px;"],
      [".b, /* c */", "width: 1px;"],
      [".b,", "#{$p}: 1px;"],
      [".b,", "margin:-1px;"],
      [".b,", "display:flex;"],
      [".b,", "color:#fff;"],
      [".b >", "--x: 1;"]
    ]) {
      const source = `.a {\n  color: red;\n  ${header}\n  ${declaration}\n}\n.y {\n  color: blue;\n}\n${tail}\n`;
      const root = parser.parse(source).rootNode;
      assert.equal(root.namedChildCount, 302, `${dialect}: ${source}`);
      assert.deepEqual(declarations(root.firstNamedChild), ["color: red;", declaration], `${dialect}: ${header}`);
    }
    // Punctuation after a statement or `{` on its line joins the break unreported; a spaced compound start is reported.
    for (const [line, expected] of [
      ["color: red; >", []],
      ["color: red; , >", []],
      ["color: red; ( ] ) ,", ["( ] ) ,"]],
      ["color: red; .", ["."]],
      ["color: red; #{}", ["#{}"]]
    ]) {
      const root = parser.parse(above(line)).rootNode;
      assert.equal(root.namedChildCount, 302, `${dialect}: ${line}`);
      assert.deepEqual(errors(root.firstNamedChild), expected, `${dialect}: ${line}`);
    }
  });
});

test("selector lines above another kind of statement keep one local error", () => {
  eachParser((parser, dialect) => {
    for (const [lines, error] of [
      ["&:hover\n  .c", "&:hover\n  .c"],
      [".b\n  .c // note", ".b\n  .c"],
      [".b\n  .c\n  /* c */\n  @include x;", ".b\n  .c"],
      [".b\n  color;", ".b\n  color"],
      ["&:hover\n  span", "&:hover\n  span"]
    ]) {
      const root = parser.parse(`.a {\n  color: red;\n  ${lines}\n}\n.y {\n  color: blue;\n}\n${tail}\n`).rootNode;
      assert.equal(root.namedChildCount, 302, `${dialect}: ${lines}`);
      assert.deepEqual(errors(root.firstNamedChild), [error], `${dialect}: ${lines}`);
    }
  });
});

test("same-line typos in a declaration block stay inside their block", () => {
  eachParser((parser, dialect) => {
    for (const block of [
      ".a { cur sor: x; }",
      ".a { a  display: flex; }",
      ".a { 1 z-index: 2; }",
      ".a {\n  c width: 1px;\n}",
      ".a {\n  .b {\n    marg in: 0;\n  }\n}"
    ]) {
      assert.equal(parser.parse(`${block}\n${tail}\n`).rootNode.namedChildCount, 301, `${dialect}: ${block}`);
    }
  });
});

test("unfinished block at-rule headers end before a declaration line", () => {
  eachParser((parser, dialect) => {
    for (const header of [
      "@if",
      "@if $a ==",
      "@each $x in",
      "@for $i from 1 through",
      "@while $i >",
      "@if $a == (",
      "@while fn(",
      "@at-root .b",
      "@media screen",
      "@MEDIA",
      "@media #{$q}",
      "@supports (x: y)",
      '@if $a == "{"',
      "@if $a == ';' and $b"
    ]) {
      const root = parser.parse(above(`color: red;\n  ${header}`)).rootNode;
      assert.equal(root.namedChildCount, 302, `${dialect}: ${header}`);
      assert.deepEqual(declarations(root.firstNamedChild), ["color: red;", "width: 1px;"], `${dialect}: ${header}`);
      assert.deepEqual(errors(root.firstNamedChild), [header], `${dialect}: ${header}`);
    }
    for (const header of ["@else if $b ==", "@else"]) {
      const root = parser.parse(above(`@if $a { b: c; }\n  ${header}`)).rootNode;
      assert.equal(root.namedChildCount, 302, `${dialect}: ${header}`);
      assert.deepEqual(errors(root.firstNamedChild), [header], `${dialect}: ${header}`);
    }
    // A comment after the header stays a comment outside the error.
    for (const comment of ["// todo", "/* todo */"]) {
      const root = parser.parse(`.a {\n  @if $a == ${comment}\n  width: 1px;\n}\n`).rootNode;
      assert.deepEqual(errors(root), ["@if $a =="], `${dialect}: ${comment}`);
    }
    // At-rules usually written at the top level keep their body in one error.
    const mixin = parser.parse(`@mixin foo\n  color: red;\n}\n.y {\n  color: blue;\n}\n`).rootNode;
    const rule = mixin.namedChildren.find(node => node.type === "rule_set");
    assert.equal(rule.text, ".y {\n  color: blue;\n}", dialect);
  });
});

test("a value missing its semicolon ends before a declaration line", () => {
  eachParser((parser, dialect) => {
    const dotted = parser.parse(above("color: map.get")).rootNode;
    assert.equal(dotted.namedChildCount, 302, dialect);
    assert.deepEqual(declarations(dotted.firstNamedChild), ["color: map.get", "width: 1px;"], dialect);
    for (const declaration of [
      "width: 1px;",
      "display:flex;",
      "margin-#{$side}: 1px;",
      "#{$p}: 1px;",
      "width: 1px /* { */;",
      // Long closed interpolations still leave the next line a whole declaration.
      `q: #{${"a".repeat(900)}};`
    ]) {
      const root = parser.parse(`.a {\n  color: red\n  ${declaration}\n}\n.y {}\n${tail}\n`).rootNode;
      assert.equal(root.namedChildCount, 302, `${dialect}: ${declaration}`);
      assert.deepEqual(declarations(root).slice(0, 2), ["color: red", declaration], `${dialect}: ${declaration}`);
    }
    // An unclosed url( keeps the following rules, although the next declaration's name joins its error.
    for (const head of ["background: url(a.png", "background: url("]) {
      assert.equal(parser.parse(above(`color: red;\n  ${head}`)).rootNode.namedChildCount, 302, `${dialect}: ${head}`);
    }
    // Groups, CSS if() branches, value lists and url( payloads may still continue onto declaration-like lines.
    for (const source of [
      ".a {\n  width: if(\n    style(--x): 1px;\n    else: 2px;\n  );\n}",
      ".a {\n  transition:\n    opacity 1s,\n    transform 1s;\n}",
      '.a {\n  background: url(\n    "a.png"\n  );\n}',
      ".a {\n  background: url(\n    data: x;\n  );\n}",
      `.a {\n  background: url(\n    data: x;${" ".repeat(1100)}\n  );\n}`,
      "@media screen and (min-width: 1px),\n  print { .x { y: z; } }",
      ".a { b: (\n  c: d,\n  e: f\n); }",
      ".a {\n  b: (\n    c: d,\n  );\n}",
      "$m: (\n  key: value,\n  other: 1\n);"
    ]) {
      assert.equal(parser.parse(source).rootNode.hasError, false, `${dialect}: ${source}`);
    }
  });
});

test("an unfinished variable or else head keeps its callable scope", () => {
  eachParser((parser, dialect) => {
    const scoped = root =>
      root.firstNamedChild.type === "mixin_definition" &&
      root.firstNamedChild.childForFieldName("parameters").text === "($tone)" &&
      root.lastNamedChild.text === ".after {}";
    for (const statement of [
      "color: $;",
      "color: $ !important;",
      "color: $/*c*/;",
      "color: fn($);",
      "$color: $ !default;",
      "@each $ in $list {}",
      "@for $ from 1 through 3 {}",
      "@if $ { color: red; }",
      "@if true {} @else",
      "@if true {} @else if $tone"
    ]) {
      const root = parser.parse(`@mixin paint($tone) { ${statement} } .after {}`).rootNode;
      assert.ok(root.hasError && scoped(root), `${dialect}: ${statement}: ${root}`);
    }
  });
});

test("recovery debt stays visible", () => {
  eachParser((parser, dialect) => {
    // A colon touching a name or an unpaired bracket still absorbs the following rules.
    for (const block of [".a { op:acity: 0.4; }", ".a {\n  color:width: 1px;\n}"]) {
      assert.notEqual(parser.parse(`${block}\n${tail}\n`).rootNode.namedChildCount, 301, `${dialect}: ${block}`);
    }
    for (const line of ["&[d", ".b []"]) {
      const root = parser.parse(above(`color: red;\n  ${line}`)).rootNode;
      assert.notDeepEqual(errors(root.firstNamedChild), [line], `${dialect}: ${line}`);
    }
  });
  // SCSS text hosts parse `#{` as an expression, so an unclosed one takes the rest of its host.
  const parser = new Parser().setLanguage(Scss);
  for (const line of ['content: "a #{$b c";', "/* see #{ fix // later */"]) {
    assert.notEqual(
      parser.parse(`.a {\n  ${line}\n  color: red;\n}\n.after {}\n${tail}\n`).rootNode.namedChildCount,
      302
    );
  }
});
