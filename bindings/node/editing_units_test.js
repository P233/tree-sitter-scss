const assert = require("node:assert/strict");
const { readFileSync, readdirSync } = require("node:fs");
const { join } = require("node:path");
const { test } = require("node:test");
const Parser = require("tree-sitter");
const Scss = require("./index.js");

const root = join(__dirname, "../..");
const query = new Parser.Query(Scss, Scss.HIGHLIGHTS_QUERY);
const selectorUnits = new Set([
  "tag_selector",
  "universal_selector",
  "parent_selector",
  "keyframe_selector",
  "id_selector",
  "class_selector",
  "placeholder_selector",
  "attribute_selector",
  "pseudo_selector",
  "compound_selector",
  "complex_selector"
]);

function parse(source, language = Scss) {
  const parser = new Parser();
  parser.setLanguage(language);
  const tree = parser.parse(source);
  assert.equal(tree.rootNode.hasError, false, `${source}\n${tree.rootNode}`);
  return tree.rootNode;
}

function isTrivia(node) {
  return node.type === "block_comment" || node.type === "inline_comment";
}

function units(node) {
  return node.namedChildren.filter(child => !isTrivia(child));
}

function shape(node) {
  return units(node).map(child => [child.type, child.text]);
}

function values(source, language) {
  return shape(parse(`.a { b: ${source}; }`, language).descendantsOfType("property_declaration")[0]).slice(1);
}

// Structural editing addresses a list item as one node, so every comma item must be one named child.
function assertOneUnitPerItem(node) {
  let count = 0;
  for (const child of node.children) {
    if (child.type === ",") {
      assert.ok(count <= 1, `${node.type} item holds ${count} units: ${node.text}`);
      count = 0;
    } else if (child.isNamed && !isTrivia(child)) {
      count++;
    } else if (!isTrivia(child)) {
      assert.ok(["(", ")"].includes(child.type), `stray ${JSON.stringify(child.type)} in ${node.text}`);
    }
  }
  assert.ok(count <= 1, `${node.type} item holds ${count} units: ${node.text}`);
}

function assertSelectorShape(node) {
  if (node.type === "compound_selector") {
    for (const child of units(node)) {
      assert.ok(selectorUnits.has(child.type) || child.type === "namespace_selector", child.type);
      assert.ok(!["compound_selector", "complex_selector"].includes(child.type), node.text);
    }
  }
  if (node.type === "complex_selector") {
    const parts = units(node);
    assert.ok(parts.length >= 2, node.text);
    parts.forEach((part, index) => {
      assert.ok(part.type === "combinator" || selectorUnits.has(part.type), part.type);
      assert.notEqual(part.type, "complex_selector", node.text);
      if (index > 0) assert.ok(part.type !== "combinator" || parts[index - 1].type !== "combinator", node.text);
    });
  }
}

function fixtures() {
  const sources = [
    readFileSync(join(root, "examples/highlight-stress.scss"), "utf8"),
    ...readdirSync(join(root, "test/highlight")).map(name => readFileSync(join(root, "test/highlight", name), "utf8"))
  ];
  for (const name of readdirSync(join(root, "test/corpus"))) {
    const text = readFileSync(join(root, "test/corpus", name), "utf8");
    for (const block of text.split(/^={3,}\n.*\n={3,}\n/m).slice(1)) sources.push(block.split(/^-{3,}$/m)[0]);
  }
  return sources;
}

test("every selector and argument list has exactly one named child per comma item", () => {
  let checked = 0;
  for (const source of fixtures()) {
    const parser = new Parser();
    parser.setLanguage(Scss);
    const tree = parser.parse(source);
    for (const node of tree.rootNode.descendantsOfType(["selectors", "arguments"])) {
      assertOneUnitPerItem(node);
      checked++;
    }
    for (const node of tree.rootNode.descendantsOfType(["compound_selector", "complex_selector"]))
      assertSelectorShape(node);
  }
  assert.ok(checked > 400, `only ${checked} lists checked`);
});

test("compound and descendant selectors are distinct nodes", () => {
  for (const language of [Scss, Scss.cssLanguage]) {
    const selectors = source => shape(parse(`${source} {}`, language).descendantsOfType("selectors")[0]);
    assert.deepEqual(selectors(".a.b"), [["compound_selector", ".a.b"]]);
    assert.deepEqual(selectors(".a .b"), [["complex_selector", ".a .b"]]);
    assert.deepEqual(selectors(".a/**/.b"), [["compound_selector", ".a/**/.b"]]);
    assert.deepEqual(selectors(".a /**/ .b"), [["complex_selector", ".a /**/ .b"]]);
    assert.deepEqual(selectors("a:hover .b, .c > .d, .e"), [
      ["complex_selector", "a:hover .b"],
      ["complex_selector", ".c > .d"],
      ["class_selector", ".e"]
    ]);
    const complex = parse(".a > .b:hover .c {}", language).descendantsOfType("complex_selector")[0];
    assert.deepEqual(shape(complex), [
      ["class_selector", ".a"],
      ["combinator", ">"],
      ["compound_selector", ".b:hover"],
      ["class_selector", ".c"]
    ]);
    assert.deepEqual(selectors("svg|circle"), [["compound_selector", "svg|circle"]]);
    assert.deepEqual(selectors("a :hover"), [["complex_selector", "a :hover"]]);
    const nested = parse(".x { > .b {} .c > {} color :red; }", language);
    assert.deepEqual(
      nested
        .descendantsOfType("selectors")
        .slice(1)
        .map(node => shape(node)),
      [[["complex_selector", "> .b"]], [["complex_selector", ".c >"]]]
    );
    assert.equal(nested.descendantsOfType("property_declaration")[0].text, "color :red;");
    assert.deepEqual(selectors(".a >>> .b"), [["complex_selector", ".a >>> .b"]]);
    assert.deepEqual(selectors("a :#{$b}"), [["complex_selector", "a :#{$b}"]]);
    const commented = parse(".x { color :red /* { */; a :hover, // don't {\n b {} }", language);
    assert.equal(commented.descendantsOfType("property_declaration")[0].text, "color :red /* { */;");
    assert.equal(commented.descendantsOfType("complex_selector")[0].text, "a :hover");
    assert.deepEqual(
      parse(".col { &-1 {} &--mod {} &.b {} & .c {} }", language)
        .descendantsOfType("selectors")
        .slice(1)
        .map(node => shape(node)[0][0]),
      ["parent_selector", "parent_selector", "compound_selector", "complex_selector"]
    );
    const pseudo = parse(".d:is(.e .f, .g) {}", language).descendantsOfType("selector_arguments")[0];
    assert.deepEqual(shape(pseudo), [
      ["complex_selector", ".e .f"],
      ["class_selector", ".g"]
    ]);
  }
});

test("spaced colons preserve declaration values and blockless selector boundaries", () => {
  for (const language of [Scss, Scss.cssLanguage]) {
    for (const gap of [" ", "\t", " /* note */ ", "\r\n"]) {
      for (const name of ["color", "--custom", "#{$name}"]) {
        const source = `.a { ${name}${gap}:red; }`;
        const declaration = parse(source, language).descendantsOfType("property_declaration")[0];
        assert.equal(declaration.childForFieldName("name").text, name);
        assert.equal(declaration.childForFieldName("value").text, "red");
        assert.equal(declaration.childForFieldName("value").type, name === "--custom" ? "raw_value" : "plain_value");
      }
    }
    for (const selector of [".b :hover", ":is(.b :hover)"]) {
      const root = parse(`.a { @extend ${selector} !optional; }`, language);
      assert.equal(root.descendantsOfType("complex_selector")[0].text, ".b :hover");
    }
  }
  for (const [source, type] of [
    ["@supports (a true) {}", "boolean"],
    ["@media (a null) {}", "null"]
  ]) {
    assert.equal(parse(source).descendantsOfType("query_group")[0].lastNamedChild.type, type);
  }
});

test("line breaks inside valid statements never end them early", () => {
  for (const language of [Scss, Scss.cssLanguage]) {
    assert.equal(
      parse(".x { @extend :is(.a\n  .b) !optional; }", language).descendantsOfType("complex_selector")[0].text,
      ".a\n  .b"
    );
    assert.equal(
      parse(".x { @extend .a,\n  .b; }", language).descendantsOfType("extend_statement")[0].firstNamedChild
        .namedChildCount,
      2
    );
    assert.equal(parse("@foo {\n  a\n  b;\n}", language).descendantsOfType("raw_statement")[0].text, "a\n  b;");
    assert.equal(
      parse(".x {\n  font\n    : bold;\n}", language).descendantsOfType("property_declaration")[0].text,
      "font\n    : bold;"
    );
    const selectors = parse(".a\n  .b,\n.c\n  > .d { color: red; }", language).descendantsOfType("selectors")[0];
    assert.deepEqual(
      selectors.namedChildren.map(node => node.text),
      [".a\n  .b", ".c\n  > .d"]
    );
  }
});

test("a spaced colon touching a name before a block starts a selector, as in Sass", () => {
  for (const language of [Scss, Scss.cssLanguage]) {
    for (const [source, selector] of [
      [".x { a :hover { color: red; } }", "a :hover"],
      ["@foo { a :hover, b { color: red; } }", "a :hover, b"],
      ["@-moz-document url-prefix() { a\n:hover { color: red; } }", "a\n:hover"]
    ]) {
      const rule = parse(source, language).descendantsOfType("rule_set").at(-1);
      assert.equal(rule.childForFieldName("selectors").text, selector, source);
    }
    for (const source of [
      ".x { font : bold { family: x; } }",
      ".x { font :{ family: x; } }",
      "@foo { font : bold { family: x; } }"
    ]) {
      const declaration = parse(source, language).descendantsOfType("property_declaration")[0];
      assert.equal(declaration.childForFieldName("name").text, "font", source);
      assert.equal(declaration.childForFieldName("body").text, "family: x;", source);
    }
  }
});

test("long spaced pseudo chains preserve every descendant and the following rule", () => {
  for (const language of [Scss, Scss.cssLanguage]) {
    for (const space of [" ", "\n"]) {
      const selector = "a" + `${space}:hover`.repeat(20000);
      const root = parse(`${selector} { color: red; } .after { width: 1px; }`, language);
      assert.equal(root.namedChildCount, 2);
      const complex = root.firstNamedChild.childForFieldName("selectors").firstNamedChild;
      assert.equal(complex.type, "complex_selector");
      assert.equal(complex.text, selector);
      assert.equal(complex.namedChildCount, 20001);
      assert.equal(complex.descendantsOfType("pseudo_selector").length, 20000);
      assert.equal(root.lastNamedChild.text, ".after { width: 1px; }");
    }
  }
});

test("interpolated pseudos keep descendant boundaries across quoted and commented braces", () => {
  for (const language of [Scss, Scss.cssLanguage]) {
    for (const expression of [
      "'hover' /* } */",
      "'hover' /* { */",
      "'hover' // }\n",
      "map.get(('}': hover), '}')",
      "map.get(('{': hover), '{')",
      ...(language === Scss ? ["\"#{'hover'}\" /* } */", "'#{map.get(('}': hover), '}')}'"] : ["'#{'"])
    ]) {
      for (const space of ["", " "]) {
        const selector = `.a${space}:#{${expression}}`;
        const root = parse(`${selector} { color: red; } .after {}`, language);
        assert.deepEqual(shape(root.firstNamedChild.childForFieldName("selectors")), [
          [space ? "complex_selector" : "compound_selector", selector]
        ]);
        assert.equal(root.firstNamedChild.childForFieldName("body").text, "color: red;");
        assert.equal(root.lastNamedChild.text, ".after {}");
      }
    }
  }
});

test("selector arguments keep direct branches and their own commas and parentheses", () => {
  for (const language of [Scss, Scss.cssLanguage]) {
    const source = '.host:is(.a /*,*/, .b:not([data-x=","], .c)):lang("en,fr") {} .after {}';
    const root = parse(source, language);
    const [outer, inner, value] = root.descendantsOfType("selector_arguments");
    assert.deepEqual(shape(outer), [
      ["class_selector", ".a"],
      ["compound_selector", '.b:not([data-x=","], .c)']
    ]);
    assert.deepEqual(shape(inner), [
      ["attribute_selector", '[data-x=","]'],
      ["class_selector", ".c"]
    ]);
    assert.deepEqual(shape(value), [["string", '"en,fr"']]);
    for (const node of [outer, inner, value]) {
      assert.equal(node.firstChild.type, "(");
      assert.equal(node.lastChild.type, ")");
      assert.equal(node.children.filter(child => child.type === ",").length, node === value ? 0 : 1);
      assertOneUnitPerItem(node);
    }
    assert.equal(root.descendantsOfType("selectors").length, 2);
    assert.equal(root.lastNamedChild.text, ".after {}");
    const nth = parse(".a:nth-child(2n of .b:is(.c, .d), .e) {}", language).descendantsOfType("nth_arguments")[0];
    assert.equal(nth.namedChildren[1].type, "selectors");
    assert.deepEqual(shape(nth.namedChildren[1]), [
      ["compound_selector", ".b:is(.c, .d)"],
      ["class_selector", ".e"]
    ]);
  }
});

test("interpolated pseudos distinguish literal URL slashes from expression comments", () => {
  for (const language of [Scss, Scss.cssLanguage]) {
    const urls = [
      "url(https://example.test)",
      "url(//example.test)",
      "URL(http://example.test/*literal)",
      "url(https://example.test/#{$path})"
    ];
    if (language === Scss) {
      urls.push(
        "url($path // }\n)",
        'url("x" // }\n)',
        "url(fn(1 // }\n))",
        "theme.url(x // }\n)",
        "myurl(x // }\n)",
        "$url(1 // }\n)",
        "éurl(x // }\n)",
        String.raw`u\72 l(x // }
)`
      );
    }
    for (const url of urls) {
      const selector = `.a :#{if(true, hover, ${url})}`;
      const root = parse(`${selector} { color: red; } .after {}`, language);
      assert.deepEqual(shape(root.firstNamedChild.childForFieldName("selectors")), [["complex_selector", selector]]);
      assert.equal(root.firstNamedChild.childForFieldName("body").text, "color: red;");
      assert.equal(root.lastNamedChild.text, ".after {}");
    }
  }
});

test("signed numbers are single values while subtraction keeps its operator", () => {
  for (const language of [Scss, Scss.cssLanguage]) {
    assert.deepEqual(values("-1px 0", language), [
      ["number", "-1px"],
      ["number", "0"]
    ]);
    assert.deepEqual(values("0 -1px", language), [
      ["number", "0"],
      ["number", "-1px"]
    ]);
    assert.deepEqual(values("0 - 1px", language), [
      ["number", "0"],
      ["operator", "-"],
      ["number", "1px"]
    ]);
    assert.deepEqual(values("translate(-50%, -50%)", language)[0], ["call_expression", "translate(-50%, -50%)"]);
    assert.deepEqual(values("#{$x}-foo", language), [["plain_value", "#{$x}-foo"]]);
    // A comment ends the number, so `px` cannot become its unit.
    assert.deepEqual(values("-1/**/px", language), [
      ["number", "-1"],
      ["plain_value", "px"]
    ]);
    assert.deepEqual(values("calc(-infinity)", language)[0], ["call_expression", "calc(-infinity)"]);
    assert.equal(parse(".a { b: calc(-infinity); }", language).descendantsOfType("calculation_constant").length, 1);
  }
  assert.deepEqual(values("-1foo-bar", Scss), [["number", "-1foo-bar"]]);
  assert.deepEqual(values("-1px-2px", Scss.cssLanguage), [["number", "-1px-2px"]]);
  // Sass subtracts on an unspaced minus after a number; CSS tokenizes a signed number.
  for (const [source, sass, css] of [
    ["0-1px", ["number", "operator", "number"], ["number", "number"]],
    ["1px-2px", ["number", "operator", "number"], ["number"]],
    ["1/-1", ["number", "operator", "number"], ["number", "operator", "number"]],
    ["fn()-1", ["call_expression", "number"], ["call_expression", "number"]],
    ["1--foo", ["number", "plain_value"], ["number"]]
  ]) {
    assert.deepEqual(
      values(source, Scss).map(([type]) => type),
      sass,
      source
    );
    assert.deepEqual(
      values(source, Scss.cssLanguage).map(([type]) => type),
      css,
      source
    );
  }
});

test("argument lists wrap multi-atom items and keep single atoms direct", () => {
  const argumentsOf = (source, language = Scss) => shape(parse(source, language).descendantsOfType("arguments")[0]);
  assert.deepEqual(argumentsOf(".a { b: fn(1px solid red, $x, $n: 2 3); }"), [
    ["argument", "1px solid red"],
    ["variable_name", "$x"],
    ["named_argument", "$n: 2 3"]
  ]);
  assert.deepEqual(argumentsOf(".a { b: calc(100% - 2px); }"), [["argument", "100% - 2px"]]);
  assert.deepEqual(argumentsOf(".a { @include m(a b, c) { d: e; } }"), [
    ["argument", "a b"],
    ["plain_value", "c"]
  ]);
  assert.deepEqual(shape(parse("@container style(--y > 1) {}", Scss).descendantsOfType("query_group")[0]), [
    ["plain_value", "--y"],
    ["operator", ">"],
    ["number", "1"]
  ]);
  assert.deepEqual(argumentsOf(".a { b: var(--x, 1px, red); }", Scss.cssLanguage), [
    ["plain_value", "--x"],
    ["argument", "1px, red"]
  ]);
  assert.deepEqual(argumentsOf(".a { b: var(--x y, z); }", Scss.cssLanguage), [
    ["argument", "--x y"],
    ["plain_value", "z"]
  ]);
  const fallback = parse(".a { b: var(--x, translate(1px, 2px)); c: var(--y, fn(a b!, c)); }", Scss.cssLanguage);
  assert.deepEqual(
    fallback
      .descendantsOfType("call_expression")
      .filter(node => node.childForFieldName("name").text !== "var")
      .map(node => node.childForFieldName("arguments").type),
    ["arguments", "raw_group"]
  );
  const conditional = parse("$x: if($condition: true, $if-true: 1, $if-false: 2);").descendantsOfType("conditional")[0];
  assert.deepEqual(
    shape(conditional).map(([type]) => type),
    ["function_name", "named_argument", "named_argument", "named_argument"]
  );
});

test("incremental edits across editing-unit boundaries agree with fresh parses", () => {
  for (const language of [Scss, Scss.cssLanguage]) {
    for (const [before, after] of [
      [".a.b {} .after {}", ".a .b {} .after {}"],
      [".a .b {} .after {}", ".a.b {} .after {}"],
      [".a, .b {} .after {}", ".a .b {} .after {}"],
      [".x { color:red; } .after {}", ".x { color :red; } .after {}"],
      [".x { --x :red; } .after {}", ".x { --x :true and false; } .after {}"],
      [".x { a :red; } .after {}", ".x { a :red {} } .after {}"],
      [".x { a :red {} } .after {}", ".x { a :red; } .after {}"],
      [".x { @extend :is(.a:hover); }", ".x { @extend :is(.a :hover); }"],
      [".x { @extend :is(.a :hover); }", ".x { @extend :is(.a:hover); }"],
      [".x { a :hover {} } .after {}", ".x { a:hover {} } .after {}"],
      [".a :#{'hover' /* x */} {} .after {}", ".a :#{'hover' /* } */} {} .after {}"],
      [".a :#{'hover' /* } */} {} .after {}", ".a :#{'hover' /* x */} {} .after {}"],
      [".a :#{'hover' /* } */} {} .after {}", ".a:#{'hover' /* } */} {} .after {}"],
      [".a:#{'hover' /* } */} {} .after {}", ".a :#{'hover' /* } */} {} .after {}"],
      [
        ".a :#{if(true, hover, url(example.test))} {} .after {}",
        ".a :#{if(true, hover, url(https://example.test))} {} .after {}"
      ],
      [
        ".a :#{if(true, hover, url(//example.test))} {} .after {}",
        '.a :#{if(true, hover, url("//example.test"))} {} .after {}'
      ],
      [".a { b: 0 -1px; } .after {}", ".a { b: 0-1px; } .after {}"],
      [".a { b: fn(a b); } .after {}", ".a { b: fn(a, b); } .after {}"],
      [".a { b: calc(1px); } .after {}", ".a { b: calc(1px + 2px); } .after {}"]
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
      const incremental = parser.parse(after, tree).rootNode;
      const fresh = parse(after, language);
      assert.equal(incremental.toString(), fresh.toString(), `${before} -> ${after}`);
      const captures = node => query.captures(node).map(({ name, node }) => [name, node.startIndex, node.endIndex]);
      assert.deepEqual(captures(incremental), captures(fresh));
    }
  }
});

test("selector lists accept the empty and trailing commas Sass allows", () => {
  for (const language of [Scss, Scss.cssLanguage]) {
    for (const [source, type, items] of [
      ["a, b, { c: d }", "selectors", ["a", "b"]],
      ["a,\nb,\n{ c: d }", "selectors", ["a", "b"]],
      ["a, , b { c: d }", "selectors", ["a", "b"]],
      ["a,, { c: d }", "selectors", ["a"]],
      ["@extend .x, ;", "selectors", [".x"]],
      ["@extend .x,", "selectors", [".x"]],
      ["a:is(.x, , .y) { c: d }", "selector_arguments", [".x", ".y"]]
    ]) {
      const node = parse(source, language).descendantsOfType(type)[0];
      assertOneUnitPerItem(node);
      assert.deepEqual(
        units(node).map(child => child.text),
        items,
        source
      );
    }
    const parser = new Parser();
    parser.setLanguage(language);
    assert.equal(parser.parse(", a { c: d }").rootNode.hasError, true);
  }
});
