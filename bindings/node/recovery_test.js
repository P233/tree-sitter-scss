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
      [".b-#{$x}", ".b-"],
      // A line-leading combinator or interpolation is skipped as one error.
      [">", ">"],
      ["+", "+"],
      ["~", "~"],
      ["> .", "> ."],
      ["#{}", "#{}"],
      ["#{$}", "#{$}"],
      ["#{$x}", "#{$x}"],
      ["#{$x}#{map.get($m, a)}", "#{$x}#{map.get($m, a)}"],
      ["#{$x", "#{$x"],
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

test("a colon typed into a name makes its line one error", () => {
  eachParser((parser, dialect) => {
    for (const [block, line] of [
      [".a { op:acity: 0.4; }", "op:acity: 0.4;"],
      [".a {\n  color:width: 1px;\n}", "color:width: 1px;"],
      [".a {\n  margin:-top: 1px;\n}", "margin:-top: 1px;"],
      // A block's last declaration may lack its `;`.
      [".a { color: red; op:acity: 0.4 }", "op:acity: 0.4"],
      [".a {\n  color: red;\n  op:acity: 0.4\n\n}", "op:acity: 0.4"],
      [".a {\n  border:top:1px solid\n  color: red;\n}", "border:top:1px solid"],
      [".a {\n  font:family: a\\b\n}", "font:family: a\\b"],
      // A comment after the line's text stays a comment.
      [".a {\n  op:acity: 0.4 /* c */\n  width: 1px;\n}", "op:acity: 0.4"],
      [".a {\n  op:acity: 0.4 // c\n}", "op:acity: 0.4"],
      [".a {\n  op:acity: 0.4\n  // c\n}", "op:acity: 0.4"]
    ]) {
      const root = parser.parse(`${block}\n${tail}\n`).rootNode;
      assert.equal(root.namedChildCount, 301, `${dialect}: ${block}`);
      assert.deepEqual(errors(root.firstNamedChild), [line], `${dialect}: ${block}`);
    }
    // Compact rules and declarations whose colons touch names stay complete.
    for (const source of [
      "a:hover{color:red;}",
      ".a{b:c;d:e}",
      ".a { background:url(data:image/png;base64,iVBOR); }",
      ":root { --x:a:b; }",
      ".a { width:if(style(--x):1px;else:2px); }",
      '.a { content:"a:b"; }',
      ".a{animation-name:fade\\:in;}",
      ".a { grid-area:md\\:main; }",
      ".a { font-family:Foo\\:Bar, serif; }",
      ".x { a:hover:focus { color: red; } }",
      ".x {\n  a:hover:not(.b) {\n    color: red;\n  }\n}"
    ]) {
      assert.equal(parser.parse(source).rootNode.hasError, false, `${dialect}: ${source}`);
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
      "@page",
      "@PAGE",
      "@page :fi",
      "@media screen",
      "@MEDIA",
      "@media #{$q}",
      "@supports (x: y)",
      '@if $a == "{"',
      "@if $a == ';' and $b",
      // A definition whose `@` does not start its line is nested; the top-level case below keeps its body.
      "@mixin m",
      "@mixin m(",
      "@mixin m()",
      "@mixin m($a: 1)",
      "@function f()",
      "@function --f()",
      "@FUNCTION --f()"
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

test("an unfinished block at-rule header ends at its block's closing brace", () => {
  eachParser((parser, dialect) => {
    // Recovery that skipped the `}` could continue the header with the next rule and keep the block open.
    const selectorPreludes = ["@page", "@page :fi", "@at-root", "@at-root .b"];
    const headers = ["@if $a ==", "@if $a ==\n    $b", "@each $x in a,", "@while fn(", "@scope (.a) to ("];
    for (const header of [...selectorPreludes, ...headers]) {
      for (const end of [" }", "\n}"]) {
        const root = parser.parse(
          `.a {\n  color: red;\n  ${header}${end}\n.y {\n  color: blue;\n}\n${tail}\n`
        ).rootNode;
        assert.equal(root.namedChildCount, 302, `${dialect}: ${header}${end}`);
        assert.deepEqual(errors(root), [header], `${dialect}: ${header}${end}`);
      }
    }
  });
});

test("a stray brace inside a header group is one error", () => {
  eachParser((parser, dialect) => {
    // A `}` inside a group that closes after it cannot be the end of the block around the header.
    const root = parser.parse(`@supports ((display:grid) and (font-family}:foo,bar)) {}\n${tail}\n`).rootNode;
    assert.equal(root.namedChildCount, 301, dialect);
    assert.deepEqual(errors(root), ["}"], dialect);
  });
});

test("damaged top-level at-rule headers keep the following rules", () => {
  eachParser((parser, dialect) => {
    // A header cut off before a rule line, also in or after a clause word, is one error before that rule. A Sass
    // expression may continue with an unquoted `#name` or the `%` operator, so only `.` and `:` lines end one.
    const control = ["@for $i from 1 t", "@for $i from 1 thr", "@for $i from 1 through", "@each $x in", "@if $a =="];
    for (const [headers, selectors] of [
      [control, [".y", ":root"]],
      [
        ["@media screen", "@supports not"],
        [".y", "%y", ":root", "#main"]
      ]
    ]) {
      for (const header of headers) {
        for (const selector of selectors) {
          const root = parser.parse(`${header}\n${selector} {\n  color: blue;\n}\n${tail}\n`).rootNode;
          assert.equal(root.namedChildCount, 302, `${dialect}: ${header} ${selector}`);
          assert.deepEqual(errors(root), [header], `${dialect}: ${header} ${selector}`);
        }
      }
    }
    // A stray brace is the only error: the `--` name after it still lexes as one and names the definition.
    const root = parser.parse(`@function {--double(--n <number>) { result: 1; }\n${tail}\n`).rootNode;
    assert.equal(root.namedChildCount, 301, dialect);
    assert.equal(root.firstNamedChild.type, "function_definition", dialect);
    assert.deepEqual(errors(root), ["{"], dialect);
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

test("an unclosed comment in a value or selector keeps the following rules", () => {
  eachParser((parser, dialect) => {
    for (const line of ["color: red /* note", "width: calc(1px /* note"]) {
      const root = parser.parse(above(line)).rootNode;
      assert.equal(root.namedChildCount, 302, `${dialect}: ${line}`);
      assert.equal(root.namedChildren[1].text, ".y {\n  color: blue;\n}", `${dialect}: ${line}`);
    }
    const root = parser.parse(`.a /* note\n.y {\n  color: blue;\n}\n${tail}\n`).rootNode;
    assert.equal(root.namedChildCount, 302, dialect);
    assert.equal(root.namedChildren[2].text, ".t0 { margin: 0px; }", dialect);
  });
});

test("an unfinished group, call or directive ends before a declaration line", () => {
  eachParser((parser, dialect) => {
    const lines = ["width: calc(1px +", "width: if(", "margin: fn(c,"];
    if (dialect === "scss") {
      lines.push(
        "@include m(1,",
        "@include m($a:",
        "color: map.get($m,",
        "color: #{$x",
        "@debug 1 +",
        "@return",
        "@if fn(\n    $b,",
        "@while fn(\n    $i,",
        "@each $x in fn(\n    a,",
        "@each $x in fn(\n    a\n    b,",
        "/* see #{ fix // later */"
      );
    }
    for (const line of lines) {
      const root = parser.parse(above(line)).rootNode;
      assert.equal(root.namedChildCount, 302, `${dialect}: ${line}`);
      assert.ok(declarations(root.firstNamedChild).includes("width: 1px;"), `${dialect}: ${line}`);
    }
    // Each later header line gets the header's own check, which also keeps a declaration whose value is a call; a name
    // alone on a group line leaves the line break to that check.
    for (const header of ["@each $x in fn(\n    a", "@if $a ==\n    $b"]) {
      for (const declaration of ["background: url(a.png);", "width: calc(1px + 2px);"]) {
        const root = parser.parse(`.a {\n  ${header}\n  ${declaration}\n}\n.y {}\n${tail}\n`).rootNode;
        assert.equal(root.namedChildCount, 302, `${dialect}: ${header} ${declaration}`);
        assert.ok(declarations(root.firstNamedChild).includes(declaration), `${dialect}: ${header} ${declaration}`);
      }
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
    // Inside an argument list, recovery may keep the group open over a declaration whose value starts with a call.
    const call = parser.parse(`.a {\n  margin: fn(c,\n  width: calc(1px + 2px);\n}\n.y {}\n${tail}\n`).rootNode;
    assert.ok(!declarations(call.firstNamedChild).includes("width: calc(1px + 2px);"), `${dialect}: call`);
    // An unpaired bracket still absorbs the following rules.
    for (const line of ["&[d", ".b []"]) {
      const root = parser.parse(above(`color: red;\n  ${line}`)).rootNode;
      assert.notDeepEqual(errors(root.firstNamedChild), [line], `${dialect}: ${line}`);
    }
    // A `{` typed at a line start before a top-level comment reads the rest of the file as its block.
    const brace = parser.parse(`.x { a: b }\n\n{/* section */\n${tail}\n`).rootNode;
    assert.notEqual(brace.namedChildCount, 303, `${dialect}: stray brace`);
  });
  // SCSS strings parse `#{` as an expression, so an unclosed one takes the rest of its string and more.
  const parser = new Parser().setLanguage(Scss);
  assert.notEqual(
    parser.parse(`.a {\n  content: "a #{$b c";\n  color: red;\n}\n.after {}\n${tail}\n`).rootNode.namedChildCount,
    302
  );
});
