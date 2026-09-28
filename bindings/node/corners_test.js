const assert = require("node:assert/strict");
const { test } = require("node:test");
const Parser = require("tree-sitter");
const Scss = require("./index.js");
const { effectiveCaptures } = require("./highlight_roles.js");

function parse(source, language) {
  const parser = new Parser();
  parser.setLanguage(language);
  const tree = parser.parse(source);
  assert.equal(tree.rootNode.hasError, false, `${source}\n${tree.rootNode}`);
  return {
    parser,
    tree,
    captures: effectiveCaptures(new Parser.Query(language, Scss.HIGHLIGHTS_QUERY), tree.rootNode)
  };
}

function role(captures, text, expected, excluded) {
  const names = captures.filter(capture => capture.node.text === text).map(capture => capture.name);
  assert.ok(names.includes(expected), `${text}: expected ${expected}, got ${names}`);
  if (excluded) assert.ok(!names.includes(excluded), `${text}: unexpected ${excluded}`);
}

test("ordinary numeric tokens avoid external leaves in deeply nested query groups", () => {
  for (const language of [Scss, Scss.cssLanguage]) {
    const parser = new Parser();
    parser.setLanguage(language);
    const symbols = [];
    parser.setLogger((message, parameters) => {
      if (message === "lexed_lookahead") symbols.push(parameters.sym);
    });
    const source = `.a { value:1px 12.3 1e2 5% 1foo2 1foo_bar; } @media ${"(".repeat(32)}width > 1px${")".repeat(32)} {}`;
    assert.equal(parser.parse(source).rootNode.hasError, false);
    assert.ok(symbols.length > 0);
    assert.ok(!symbols.includes("_scalar_number"));
    assert.ok(!symbols.includes("_dimension_number"));
    symbols.length = 0;
    assert.equal(parser.parse(".a { value:1foo-; }").rootNode.hasError, false);
    assert.ok(symbols.includes("_dimension_number"));
  }
});

test("dimension units consume complete identifiers and percentage stops at its percent sign", () => {
  for (const language of [Scss, Scss.cssLanguage]) {
    for (const value of [
      "1foo1bar",
      "1foo-bar",
      "1foo_bar",
      "1foo-",
      "1_foo",
      "1-foo",
      "1é2",
      "1😀2",
      "1e",
      "1e-",
      "1e-foo",
      "1e--foo",
      "1e+2px",
      "1E-2px",
      ".5foo2",
      String.raw`1p\78`,
      String.raw`1\31 x`
    ]) {
      const { tree, captures } = parse(`.a { value: ${value}; color:red; } .after {}`, language);
      const numbers = tree.rootNode.descendantsOfType("number");
      assert.deepEqual(
        numbers.map(node => node.text),
        [value]
      );
      assert.equal(numbers[0].namedChildren.length, 1);
      assert.equal(numbers[0].namedChildren[0].type, "unit");
      role(captures, value, "number");
      role(captures, numbers[0].namedChildren[0].text, "type");
      assert.equal(tree.rootNode.lastNamedChild.text, ".after {}");
    }
    for (const [value, expected] of [
      [
        "1%foo",
        [
          ["number", "1%"],
          ["plain_value", "foo"]
        ]
      ],
      [
        "1 px",
        [
          ["number", "1"],
          ["plain_value", "px"]
        ]
      ],
      [
        "1/**/px",
        [
          ["number", "1"],
          ["block_comment", "/**/"],
          ["plain_value", "px"]
        ]
      ],
      ...["1.2", "1e2", "1%", "1foo-"].map(number => [
        `${number} /**/px`,
        [
          ["number", number],
          ["block_comment", "/**/"],
          ["plain_value", "px"]
        ]
      ]),
      [
        "1foo2.5bar",
        [
          ["number", "1foo2"],
          ["number", ".5bar"]
        ]
      ],
      [
        "1.2.3",
        [
          ["number", "1.2"],
          ["number", ".3"]
        ]
      ],
      [
        "1e+",
        [
          ["number", "1e"],
          ["operator", "+"]
        ]
      ],
      [
        '1foo2"x"#abc',
        [
          ["number", "1foo2"],
          ["string", '"x"'],
          ["hex_color", "#abc"]
        ]
      ]
    ]) {
      const { tree } = parse(`.a { value: ${value}; color:red; } .after {}`, language);
      assert.deepEqual(
        tree.rootNode
          .descendantsOfType("property_declaration")[0]
          .namedChildren.slice(1)
          .map(node => [node.type, node.text]),
        expected
      );
      assert.equal(tree.rootNode.lastNamedChild.text, ".after {}");
    }
  }
});

test("dimension units preserve CSS identifiers and Sass subtraction and escape boundaries", () => {
  for (const [value, css, scss] of [
    ["1px-2px", ["1px-2px"], ["1px", "2px"]],
    ["1foo--2", ["1foo--2"], ["1foo-", "2"]],
    ["1foo-2", ["1foo-2"], ["1foo", "2"]],
    ["1foo-.2", ["1foo-", ".2"], ["1foo", ".2"]],
    ["1--foo", ["1--foo"], ["1"]],
    ["1p\\78\r\nx", ["1p\\78\r\nx"], ["1p\\78\r"]]
  ]) {
    for (const [language, expected] of [
      [Scss.cssLanguage, css],
      [Scss, scss]
    ]) {
      const { tree } = parse(`.a { value: ${value}; color:red; } .after {}`, language);
      assert.deepEqual(
        tree.rootNode.descendantsOfType("number").map(node => node.text),
        expected
      );
      assert.equal(
        tree.rootNode.descendantsOfType("operator").length,
        language === Scss && /^1(?:px-2px|foo--?2|foo-\.2)$/.test(value) ? 1 : 0
      );
      assert.equal(tree.rootNode.lastNamedChild.text, ".after {}");
    }
  }
});

test("quoted continuations accept CSS newlines without allowing them in unquoted URLs", () => {
  for (const language of [Scss, Scss.cssLanguage]) {
    for (const newline of ["\n", "\r\n", "\r", "\f"]) {
      for (const quote of ['"', "'"]) {
        const value = `${quote}a\\${newline}b${quote}`;
        const { tree, captures } = parse(`.a { value:${value}; color:red; } .after {}`, language);
        assert.deepEqual(
          tree.rootNode.descendantsOfType("string").map(node => node.text),
          [value]
        );
        assert.deepEqual(
          tree.rootNode.descendantsOfType("escape_sequence").map(node => node.text),
          [`\\${newline}`]
        );
        role(captures, `\\${newline}`, "string.escape");
        assert.equal(tree.rootNode.lastNamedChild.text, ".after {}");
        const parser = new Parser();
        parser.setLanguage(language);
        assert.equal(
          parser.parse(`.a { value:${quote}a${newline}b${quote}; color:red; } .after {}`).rootNode.hasError,
          true
        );
      }
      const parser = new Parser();
      parser.setLanguage(language);
      const invalid = parser.parse(`.a { value:url(a\\${newline}b); color:red; } .after {}`).rootNode;
      assert.equal(invalid.hasError, true);
      assert.equal(invalid.lastNamedChild.text, ".after {}");
    }
  }
});

test("Unicode and escaped hash values retain complete names and adjacent token boundaries", () => {
  for (const language of [Scss, Scss.cssLanguage]) {
    for (const value of ["#颜色", "#😀", "#a\u0301", "#123颜色", String.raw`#\66 oo`, String.raw`#ab\63`]) {
      const { tree, captures } = parse(`.a { value: ${value}; color:red; } .after {}`, language);
      assert.deepEqual(
        tree.rootNode.descendantsOfType("hash_value").map(node => node.text),
        [value]
      );
      assert.equal(tree.rootNode.descendantsOfType("hex_color").length, 0);
      assert.equal(tree.rootNode.lastNamedChild.text, ".after {}");
      role(captures, value, "constant");
    }
    const { tree } = parse('.a { value: 1"x" 1#abc #abc#def #123颜色"x"; }', language);
    const value = tree.rootNode.descendantsOfType("property_declaration")[0];
    assert.deepEqual(
      value.namedChildren.slice(1).map(node => [node.type, node.text]),
      [
        ["number", "1"],
        ["string", '"x"'],
        ["number", "1"],
        ["hex_color", "#abc"],
        ["hex_color", "#abc"],
        ["hex_color", "#def"],
        ["hash_value", "#123颜色"],
        ["string", '"x"']
      ]
    );
  }
});

test("incremental numeric and hash boundary edits retain fresh tree ranges and captures", () => {
  const point = (source, end) => {
    const lines = source.slice(0, end).split("\n");
    return { row: lines.length - 1, column: lines.at(-1).length };
  };
  const shape = node => [node.type, node.startIndex, node.endIndex, node.children.map(shape)];
  for (const language of [Scss, Scss.cssLanguage]) {
    const query = new Parser.Query(language, Scss.HIGHLIGHTS_QUERY);
    for (const [left, right] of [
      ["1px", "1/**/px"],
      ["1.2px", "1.2/**/px"],
      ["1e2px", "1e2 /**/px"],
      ["1%foo", "1%/**/foo"],
      ["1foo-", "1foo-/**/px"],
      ["1foo--2", "1foo--2/**/px"],
      ["1px", "1 px"],
      ["1px", "1\npx"],
      ["1foo", "1foo2"],
      ["1foo-2", "1foo-2px"],
      ["1e+", "1e+2px"],
      ["1%foo", "1foo"],
      ["1p\\78x", "1p\\78\r\nx"],
      ["1p\\78x", "1p\\\nx"],
      ["#abc", "#abc颜色"],
      ["#abc", String.raw`#ab\63`]
    ]) {
      for (const [oldValue, newValue] of [
        [left, right],
        [right, left]
      ]) {
        const before = `.a { value:${oldValue}; color:red; } .after {}`;
        const after = `.a { value:${newValue}; color:red; } .after {}`;
        const parser = new Parser();
        parser.setLanguage(language);
        const previous = parser.parse(before);
        let start = 0;
        while (before[start] === after[start]) start++;
        let oldEnd = before.length;
        let newEnd = after.length;
        while (before[oldEnd - 1] === after[newEnd - 1]) {
          oldEnd--;
          newEnd--;
        }
        previous.edit({
          startIndex: start,
          oldEndIndex: oldEnd,
          newEndIndex: newEnd,
          startPosition: point(before, start),
          oldEndPosition: point(before, oldEnd),
          newEndPosition: point(after, newEnd)
        });
        const incremental = parser.parse(after, previous).rootNode;
        const fresh = parser.parse(after).rootNode;
        assert.deepEqual(shape(incremental), shape(fresh), `${before} → ${after}`);
        assert.equal(incremental.lastNamedChild.text, ".after {}");
        const captures = node => query.captures(node).map(({ name, node }) => [name, node.startIndex, node.endIndex]);
        assert.deepEqual(captures(incremental), captures(fresh));
      }
    }
  }
});

test("escaped custom property prefixes are ordinary property names", () => {
  for (const language of [Scss, Scss.cssLanguage]) {
    for (const name of [String.raw`\2d\2d x`, String.raw`-\2d x`, String.raw`\-\-x`]) {
      const { tree, captures } = parse(`.a { ${name}: {a:b;}; color:red; } .after {}`, language);
      assert.equal(tree.rootNode.descendantsOfType("raw_value").length, 0);
      assert.equal(tree.rootNode.descendantsOfType("nested_property")[0].childForFieldName("name").text, name);
      assert.equal(tree.rootNode.lastNamedChild.text, ".after {}");
      role(captures, name, "property");
    }
  }
});

test("selector queries accept any letter case without claiming escaped or longer names", () => {
  for (const language of [Scss, Scss.cssLanguage]) {
    for (const name of ["selector", "SeLeCtOr"]) {
      const { tree, captures } = parse(`@supports ${name}(:has(> .foo)) { .ok {} } .after {}`, language);
      assert.equal(tree.rootNode.descendantsOfType("selector_query").length, 1);
      assert.equal(tree.rootNode.lastNamedChild.text, ".after {}");
      role(captures, name, "function");
      role(captures, ".foo", "attribute");
    }
    for (const name of [
      "selectorx",
      "SeLeCtOrX",
      String.raw`s\65 lectorx`,
      String.raw`s\65 lector`,
      "selector#{$suffix}"
    ]) {
      const { tree } = parse(`.a { value: ${name}(foo); }`, language);
      assert.equal(tree.rootNode.descendantsOfType("selector_query").length, 0);
      assert.deepEqual(
        tree.rootNode.descendantsOfType("call_expression").map(node => node.childForFieldName("name").text),
        [name]
      );
    }
  }
});

test("boolean and range feature names retain property roles without classifying values", () => {
  for (const language of [Scss, Scss.cssLanguage]) {
    for (const condition of [
      "(color)",
      "(/*a*/ color)",
      "(color /*b*/)",
      "(/*a*/ color /*b*/)",
      "(//a\n color //b\n)",
      "(width >= 700px)",
      "(width /*a*/ > /*b*/ 1px)",
      "(400px < width < 1000px)",
      "(width = 40rem)",
      "(-10px < width)",
      "(1/2 < aspect-ratio)",
      "(1 /*a*/ / /*b*/ 2 /*c*/ < /*d*/ aspect-ratio)",
      "(#{$left} < width)",
      "($left < width)",
      "(theme.$left < width)"
    ]) {
      const name = condition.includes("color")
        ? "color"
        : condition.includes("aspect-ratio")
          ? "aspect-ratio"
          : "width";
      const { tree, captures } = parse(`@media ${condition} {} .after {}`, language);
      role(captures, name, "property");
      assert.equal(tree.rootNode.lastNamedChild.text, ".after {}");
    }
    const { captures } = parse("@media screen and (orientation: landscape) {}", language);
    role(captures, "screen", "constant", "property");
    role(captures, "landscape", "constant", "property");
    const equality = parse("@media (orientation = landscape) and (width > var(--x)) {}", language).captures;
    role(equality, "orientation", "property");
    role(equality, "landscape", "constant", "property");
    role(equality, "--x", "variable", "property");
    const ordered = parse("@media (width < height) {}", language).captures;
    role(ordered, "width", "property");
    role(ordered, "height", "constant", "property");
    const style = parse("@container style(--theme: landscape) {}", language).captures;
    role(style, "--theme", "variable", "property");
    role(style, "landscape", "constant", "property");
  }
});

test("value pseudos and column selectors retain their argument roles", () => {
  for (const language of [Scss, Scss.cssLanguage]) {
    for (const [pseudo, argument] of [
      [":state", "checked"],
      ["::scroll-button", "left"]
    ]) {
      const { captures } = parse(`.a${pseudo}(${argument}) {}`, language);
      role(captures, argument, "constant", "tag");
    }
    const { captures } = parse("col || td:nth-col(2n+1), td:nth-last-col(odd) {}", language);
    role(captures, "col", "tag", "module");
    role(captures, "||", "operator");
    role(captures, "2n+1", "number");
    assert.ok(!captures.some(capture => capture.node.text === "n" && capture.name === "type"));
  }
});

test("CSS function types support components, multipliers and type unions", () => {
  for (const language of [Scss, Scss.cssLanguage]) {
    for (const type of ["<length>+", "<color>#", "auto", "typex", "type", "type(<number> | <percentage>)", "type(*)"]) {
      const { tree } = parse(`@function --foo(--a ${type}) returns ${type} { result: var(--a); } .after {}`, language);
      assert.equal(tree.rootNode.firstNamedChild.type, "function_definition");
      assert.equal(tree.rootNode.lastNamedChild.text, ".after {}");
    }
  }
  parse("@function foo($a: (x: 1, y: 2), $rest...) { @return $a; }", Scss);
});

test("CSS function parameters share escaped and Unicode custom property spelling", () => {
  for (const language of [Scss, Scss.cssLanguage]) {
    for (const name of ["--wide", "--宽", String.raw`--\78 `]) {
      const { tree, captures } = parse(
        `@function --f(${name} <length>: 1px) { result: var(--x); } .after {}`,
        language
      );
      assert.deepEqual(
        tree.rootNode.descendantsOfType("parameter_name").map(node => node.text),
        [name]
      );
      role(captures, name, "variable.parameter");
      role(captures, "length", "type");
      assert.equal(tree.rootNode.lastNamedChild.text, ".after {}");
    }
  }
});

test("CSS result descriptors accept any letter case without claiming escaped, longer, or interpolated names", () => {
  for (const language of [Scss, Scss.cssLanguage]) {
    for (const name of ["result", "RESULT"]) {
      const { tree, captures } = parse(`@function --f() { ${name}: {payload:value}; color:red; } .after {}`, language);
      assert.equal(tree.rootNode.descendantsOfType("nested_property").length, 0);
      assert.equal(tree.rootNode.descendantsOfType("raw_value").length, 1);
      assert.equal(tree.rootNode.descendantsOfType("property_declaration").length, 2);
      assert.equal(tree.rootNode.lastNamedChild.text, ".after {}");
      role(captures, name, "property");
      role(captures, "payload", "constant", "property");
      role(captures, "value", "constant", "property");
    }
    for (const name of ["resultx", "RESULTant", "result#{$x}", String.raw`r\65 sult`]) {
      const { tree } = parse(`.a { ${name}: {payload:value}; }`, language);
      assert.equal(tree.rootNode.descendantsOfType("raw_value").length, 0);
      assert.equal(tree.rootNode.descendantsOfType("nested_property").length, 1);
      assert.equal(tree.rootNode.descendantsOfType("nested_property")[0].childForFieldName("name").text, name);
    }
  }
});

test("CSS var fallback groups preserve arguments, token roles and enclosing statements", () => {
  for (const name of ["var", "VAR"]) {
    for (const fallback of [
      "[a;b]",
      "{a:b;c:d}",
      "1px [a;b] calc(2 + 3) red",
      "foo([a;b], {c:d})",
      "[a!b] foo(a!b)",
      "(a;b)",
      "a:b?c@d"
    ]) {
      const source = `.a { color: ${name}(--x, ${fallback}); margin:0; } .after {}`;
      const { tree, captures } = parse(source, Scss.cssLanguage);
      const call = tree.rootNode.descendantsOfType("call_expression")[0];
      assert.equal(call.childForFieldName("name").text, name);
      assert.equal(call.childForFieldName("arguments").firstNamedChild.text, "--x");
      assert.equal(call.childForFieldName("arguments").firstNamedChild.type, "plain_value");
      assert.equal(tree.rootNode.descendantsOfType("property_declaration").length, 2);
      assert.equal(tree.rootNode.descendantsOfType("rule_set").length, 2);
      assert.equal(tree.rootNode.lastNamedChild.text, ".after {}");
      role(captures, name, "function", "attribute");
      for (let index = 0; index < source.length; index++) {
        if (!/\s/.test(source[index])) {
          assert.ok(
            captures.some(({ node }) => node.startIndex <= index && index < node.endIndex),
            `uncovered ${JSON.stringify(source[index])} at ${index} in ${source}`
          );
        }
      }
      if (fallback.includes("calc")) {
        role(captures, "1px", "number");
        role(captures, "calc", "function");
        role(captures, "red", "constant");
      }
      if (fallback.startsWith("foo")) role(captures, "foo", "function");
    }
  }
  for (const source of [".a { x: var(--x, [a,b]); }", ".a { x: var(--x, 1px, calc(2 + 3), red); }"]) {
    const css = parse(source, Scss.cssLanguage);
    const sass = parse(source, Scss);
    assert.deepEqual(
      css.captures.map(({ name, node }) => [name, node.text]),
      sass.captures.map(({ name, node }) => [name, node.text])
    );
  }
  // CSS makes everything after the first comma one fallback; Sass passes an ordinary argument list.
  const units = language =>
    parse(".a { x: var(--x, 1px, calc(2 + 3), red); }", language)
      .tree.rootNode.descendantsOfType("arguments")[0]
      .namedChildren.map(node => node.text);
  assert.deepEqual(units(Scss.cssLanguage), ["--x", "1px, calc(2 + 3), red"]);
  assert.deepEqual(units(Scss), ["--x", "1px", "calc(2 + 3)", "red"]);
  for (const fallback of ["#{$x}", "#{a:{b:c;}}", '"#{$x}"', '[#{$x}, "#{literal}"]']) {
    const { tree } = parse(`.a { x:var(--x,${fallback}); margin:0; } .after {}`, Scss.cssLanguage);
    assert.equal(tree.rootNode.descendantsOfType("interpolation").length, 0);
    assert.equal(tree.rootNode.descendantsOfType("property_declaration").length, 2);
    assert.equal(tree.rootNode.lastNamedChild.text, ".after {}");
  }
  for (const name of ["var", "VAR", String.raw`v\61 r`, "varx", "module.var", "var#{$suffix}"]) {
    const parser = new Parser();
    parser.setLanguage(Scss);
    assert.equal(parser.parse(`.a { x: ${name}(--x, [a;b]); }`).rootNode.hasError, true);
  }
  for (const name of ["varx", "module.var", "var#{$suffix}", String.raw`v\61 r`]) {
    const { tree } = parse(`.a { x: ${name}(--x, 1px); }`, Scss.cssLanguage);
    assert.equal(tree.rootNode.descendantsOfType("call_expression")[0].text, `${name}(--x, 1px)`);
  }
});

test("result raw values are limited to CSS function bodies and their conditional groups", () => {
  for (const language of [Scss, Scss.cssLanguage]) {
    for (const name of ["result", "RESULT"]) {
      for (const source of [`.a { ${name}: $x + 1px; }`, `@function f() { ${name}: $x + 1px; }`]) {
        const { tree, captures } = parse(source, language);
        assert.equal(tree.rootNode.descendantsOfType("raw_value").length, 0);
        assert.deepEqual(
          tree.rootNode.descendantsOfType("variable_name").map(node => node.text),
          ["$x"]
        );
        role(captures, "$x", "variable");
        role(captures, "+", "operator");
      }
      for (const body of [
        `${name}: {a:b;c:d};`,
        `@media (color) { @supports (display:grid) { ${name}: {a:b;c:d}; } }`
      ]) {
        const { tree } = parse(`@function --f() { ${body} } .after {}`, language);
        assert.equal(tree.rootNode.descendantsOfType("raw_value").length, 1);
        assert.equal(tree.rootNode.descendantsOfType("nested_property").length, 0);
        assert.equal(tree.rootNode.lastNamedChild.text, ".after {}");
      }
    }
  }
});

test("CSS conditional spellings and empty branches preserve Sass call boundaries", () => {
  for (const language of [Scss, Scss.cssLanguage]) {
    for (const name of ["if", "IF"]) {
      for (const otherwise of ["else", "ELSE"]) {
        for (const values of [
          ["red", "blue"],
          ["", "blue"],
          ["red", ""]
        ]) {
          const { tree, captures } = parse(
            `.a { color: ${name}(style(--x: dark): ${values[0]}; ${otherwise}: ${values[1]}); margin:0; } .after {}`,
            language
          );
          assert.equal(tree.rootNode.descendantsOfType("conditional").length, 1);
          assert.equal(tree.rootNode.descendantsOfType("conditional_branch").length, 2);
          assert.equal(tree.rootNode.descendantsOfType("property_declaration").length, 2);
          assert.equal(tree.rootNode.lastNamedChild.text, ".after {}");
          role(captures, name, "function");
          role(captures, otherwise, "keyword.conditional", "constant");
        }
      }
    }
    for (const name of ["iffy", "IF", "module.IF", "IF#{$suffix}", String.raw`i\66`]) {
      const { tree } = parse(`.a { x: ${name}(true,1,2); }`, language);
      assert.equal(tree.rootNode.descendantsOfType("conditional").length, 0);
      assert.equal(tree.rootNode.descendantsOfType("call_expression").length, 1);
      assert.equal(tree.rootNode.descendantsOfType("call_expression")[0].text, `${name}(true,1,2)`);
    }
    const { tree, captures } = parse(".a { x: if(elsewhere: 1; ELSE#{$suffix}: 2; else: 3); }", language);
    assert.deepEqual(
      tree.rootNode.descendantsOfType("plain_value").map(node => node.text),
      ["elsewhere", "ELSE#{$suffix}"]
    );
    role(captures, "elsewhere", "constant", "keyword");
    role(captures, "ELSE#{$suffix}", "constant", "keyword");
  }
});

test("conditional media queries reuse ordered query groups and preserve normal calls", () => {
  for (const language of [Scss, Scss.cssLanguage]) {
    for (const condition of ["media((width = 600px))", "MeDiA((width > 600px) and (color))"]) {
      const { tree, captures } = parse(
        `.a { width: if(${condition}: 1px; else: 2px); color:red; } .after {}`,
        language
      );
      assert.ok(tree.rootNode.descendantsOfType("query_group").length > 0);
      assert.equal(tree.rootNode.descendantsOfType("list").length, 0);
      assert.equal(tree.rootNode.descendantsOfType("conditional_branch").length, 2);
      assert.equal(tree.rootNode.lastNamedChild.text, ".after {}");
      role(captures, condition.includes("width") ? "width" : "color", "property");
    }
    for (const name of ["media", "mediax", "module.media", "media#{$suffix}", String.raw`m\65 dia`]) {
      const { tree } = parse(`.a { x: ${name}(a,b); }`, language);
      assert.equal(tree.rootNode.descendantsOfType("query_group").length, 0);
      assert.equal(tree.rootNode.descendantsOfType("call_expression")[0].text, `${name}(a,b)`);
    }
  }
});

test("CSS conditional query calls retain full declaration values and following branches", () => {
  for (const language of [Scss, Scss.cssLanguage]) {
    for (const condition of ["style(--x: {a:b;})", "style(--x: [a;b])", "supports(font-family: a,b)"]) {
      const { tree } = parse(`.a { width: if(${condition}: 1px; else: 2px); color:red; } .after {}`, language);
      const feature = tree.rootNode.descendantsOfType("feature_query")[0];
      assert.equal(feature.text, condition.slice(condition.indexOf("(") + 1, -1));
      assert.equal(tree.rootNode.descendantsOfType("conditional_branch").length, 2);
      assert.equal(tree.rootNode.descendantsOfType("property_declaration").length, 2);
      assert.equal(tree.rootNode.lastNamedChild.text, ".after {}");
    }
  }
  for (const [source, containers] of [
    ["$x: if((a,b), (c:d), (e,f));", ["list", "map", "list"]],
    ["$x: if((a:b), (c:d), (e:f));", ["map", "map", "map"]]
  ]) {
    const { tree } = parse(source, Scss);
    const conditional = tree.rootNode.descendantsOfType("conditional")[0];
    assert.deepEqual(
      conditional.namedChildren.slice(1).map(node => node.type),
      containers
    );
    assert.equal(tree.rootNode.descendantsOfType("query_group").length, 0);
  }
});

test("corner-case incremental parses and captures agree with fresh parses", () => {
  for (const language of [Scss, Scss.cssLanguage]) {
    for (const [before, after] of [
      ["@supports selector(:has(.foo)) {} .after {}", "@supports SELECTOR(:has(.foo)) {} .after {}"],
      [".a { --x: {a:b;}; color:red; } .after {}", String.raw`.a { \2d\2d x: {a:b;}; color:red; } .after {}`],
      ["@media (width: 40rem) {} .after {}", "@media (width > 40rem) {} .after {}"],
      ["@function --f(--a <length>) {} .after {}", "@function --f(--a <length>+) {} .after {}"],
      ["@function --f() { result: {a:b;}; } .after {}", String.raw`@function --f() { r\65 sult: {a:b;}; } .after {}`],
      ["@function f() { result: $x + 1px; } .after {}", "@function --f() { result: $x + 1px; } .after {}"],
      [".a { result: $x + 1px; } .after {}", "@function --f() { @media (color) { result: $x + 1px; } } .after {}"],
      [".a { x: IF(true,1,2); } .after {}", ".a { x: IF(media((width = 1px)):; ELSE:2); } .after {}"],
      [".a { x: if(media((color)):1; else:2); } .after {}", ".a { x: if(media((color)):; else:); } .after {}"],
      [
        ".a { width: if(style(--x: a): 1px; else: 2px); } .after {}",
        ".a { width: if(style(--x: [a;b]): 1px; else: 2px); } .after {}"
      ],
      ...(language === Scss.cssLanguage
        ? [
            [".a { x:var(--x,[a,b]); color:red; } .after {}", ".a { x:var(--x,[a;b]); color:red; } .after {}"],
            [".a { x:var(--x,red); color:red; } .after {}", ".a { x:var(--x,{a:b;c:d}); color:red; } .after {}"],
            [".a { x:var(--x,red); color:red; } .after {}", ".a { x:var(--x,#{a:{b:c;}}); color:red; } .after {}"]
          ]
        : [])
    ]) {
      const { parser, tree } = parse(before, language);
      let start = 0;
      while (before[start] === after[start]) start++;
      let oldEnd = before.length;
      let newEnd = after.length;
      while (before[oldEnd - 1] === after[newEnd - 1]) {
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
      assert.equal(incremental.rootNode.toString(), fresh.rootNode.toString());
      const query = new Parser.Query(language, Scss.HIGHLIGHTS_QUERY);
      const captures = current =>
        query.captures(current.rootNode).map(({ name, node }) => [name, node.startIndex, node.endIndex]);
      assert.deepEqual(captures(incremental), captures(fresh));
    }
  }
});
