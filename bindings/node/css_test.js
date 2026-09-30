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

test("CSS CRLF escapes retain identifier boundaries and original source ranges", () => {
  const normalized = node => [
    node.type,
    node.text.replaceAll("\r\n", "\n"),
    node.isMissing,
    ...node.children.map((child, index) => [node.fieldNameForChild(index), normalized(child)])
  ];
  const query = new Parser.Query(Scss.cssLanguage, Scss.HIGHLIGHTS_QUERY);
  for (const source of [
    ".a:l\\61\r\nng(en) {}",
    ".a { width: c\\61\r\nlc(pi); }",
    "@m\\65\r\ndia screen { .x\\31\r\nb { image: u\\72\r\nl(foo); } }",
    ".a:nth-\\63\r\nhild(.b) {}",
    '.a { --raw: foo\\61\r\nbar; width: 1p\\78\r\nx; content: "a\\61\r\nb"; }'
  ]) {
    const tree = parse(source);
    const lf = parse(source.replaceAll("\r\n", "\n"));
    assert.deepEqual(normalized(tree.rootNode), normalized(lf.rootNode), source);
    assert.deepEqual(
      query.captures(tree.rootNode).map(({ name, node }) => [name, node.text.replaceAll("\r\n", "\n")]),
      query.captures(lf.rootNode).map(({ name, node }) => [name, node.text]),
      source
    );
    for (const { node } of query.captures(tree.rootNode)) {
      assert.equal(node.text, source.slice(node.startIndex, node.endIndex));
    }
  }
  const source = ".x\\31\r\nb {}";
  assert.deepEqual(texts(parse(source), "class_selector"), [".x\\31\r\nb"]);
  const sass = parse(source, new Parser(), undefined, Scss);
  assert.deepEqual(texts(sass, "class_selector"), [".x\\31\r"]);
  assert.deepEqual(texts(sass, "tag_selector"), ["b"]);
});

test("CSS CRLF preprocessing follows the logical input across included ranges", () => {
  const source = ".a:l\\61\r omitted \nng(en) {}";
  const split = source.indexOf(" omitted ");
  const position = index => {
    const lines = source.slice(0, index).split("\n");
    return { row: lines.length - 1, column: lines.at(-1).length };
  };
  const range = (start, end) => ({
    startIndex: start,
    endIndex: end,
    startPosition: position(start),
    endPosition: position(end)
  });
  const parser = new Parser();
  parser.setLanguage(Scss.cssLanguage);
  const tree = parser.parse(source, undefined, {
    includedRanges: [range(0, split), range(split + " omitted ".length, source.length)]
  });
  assert.equal(tree.rootNode.hasError, false, tree.rootNode.toString());
  assert.deepEqual(texts(tree, "pseudo_name"), ["l\\61\r omitted \nng"]);
  assert.deepEqual(texts(tree, "selector_arguments"), ["(en)"]);
});

test("escaped priority keywords report a local error without losing following rules", () => {
  for (const language of [Scss, Scss.cssLanguage]) {
    const parser = new Parser();
    parser.setLanguage(language);
    for (const priority of [String.raw`!imp\6f rtant`, "!imp\\6f\r\nrtant"]) {
      const source = `.a { color: red ${priority}; width: 1px; } .after {}`;
      const root = parser.parse(source).rootNode;
      assert.equal(root.hasError, true, source);
      assert.equal(root.lastNamedChild.text, ".after {}", source);
      assert.equal(root.descendantsOfType("property_declaration").at(-1).text, "width: 1px;", source);
    }
  }
});

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

test("one Sass interpolation preserves mixed value types and their ranges", () => {
  const expression = "#{'gap' $gap #369 true null math.div(12px, 3)}";
  const tree = parse(`.a { content: "${expression}"; }`, new Parser(), undefined, Scss);
  const [interpolation] = tree.rootNode.descendantsOfType("interpolation");
  assert.equal(interpolation.text, expression);
  assert.deepEqual(
    interpolation.namedChildren.map(node => [node.type, node.text]),
    [
      ["string", "'gap'"],
      ["variable_name", "$gap"],
      ["hex_color", "#369"],
      ["boolean", "true"],
      ["null", "null"],
      ["call_expression", "math.div(12px, 3)"]
    ]
  );
});

test("keyword-shaped CSS namespace prefixes keep their complete names and module roles", () => {
  for (const language of [Scss, Scss.cssLanguage]) {
    const query = new Parser.Query(language, Scss.HIGHLIGHTS_QUERY);
    for (const name of [
      "svg",
      "calc",
      "min",
      "style",
      "media",
      "supports",
      "selector",
      "if",
      "else",
      "result",
      "url",
      "URL",
      "true",
      "false",
      "null",
      "not",
      "and",
      "or",
      "element",
      "expression",
      "--x",
      "x-long",
      "色",
      "calc-extra",
      String.raw`c\61 lc`
    ]) {
      const rule = `${name}|a, a[${name}|href] { color: red; }`;
      for (const body of [rule, `.outer { ${rule} }`]) {
        const tree = parse(`@namespace ${name} "urn:test"; ${body}`, new Parser(), undefined, language);
        assert.deepEqual(texts(tree, "namespace_name"), [name, name, name]);
        assert.deepEqual(
          query
            .captures(tree.rootNode)
            .filter(({ name }) => name === "module")
            .map(({ node }) => node.text),
          [name, name, name]
        );
        assert.deepEqual(texts(tree, "function_name"), []);
        assert.deepEqual(texts(tree, "boolean"), []);
        assert.deepEqual(texts(tree, "null"), []);
      }
    }
    const tree = parse(
      '@namespace url("urn:default"); @namespace url url("urn:named"); url|a, *|a, |a {}',
      new Parser(),
      undefined,
      language
    );
    assert.deepEqual(texts(tree, "namespace_name"), ["url", "url"]);
    assert.equal(texts(tree, "url").length, 2);
    assert.deepEqual(texts(tree, "namespace_selector"), ["url|", "*|", "|"]);
  }
});

test("namespace prefixes do not reclassify ordinary names or other pipe syntax", () => {
  for (const language of [Scss, Scss.cssLanguage]) {
    for (const name of ["calc", "url", "true", "false", "null", "not", "and", "or", "element", "expression"]) {
      const tree = parse(`${name} { ${name}: red; .outer { ${name} {} } }`, new Parser(), undefined, language);
      assert.deepEqual(texts(tree, "tag_selector"), [name, name]);
      assert.deepEqual(texts(tree, "property_name"), [name]);
      assert.deepEqual(texts(tree, "namespace_name"), []);
    }
    const tree = parse("a |b, a||b, a[lang|=en] {}", new Parser(), undefined, language);
    assert.deepEqual(texts(tree, "namespace_name"), []);
    assert.deepEqual(texts(tree, "namespace_selector"), ["|"]);
    assert.deepEqual(texts(tree, "combinator"), ["||"]);
    assert.deepEqual(texts(tree, "attribute_operator"), ["|="]);
    assert.equal(texts(tree, "complex_selector").length, 2);
  }
});

test("incremental namespace qualification preserves fresh trees and captures", () => {
  const shape = node => [node.type, node.startIndex, node.endIndex, node.isMissing, ...node.children.map(shape)];
  for (const language of [Scss, Scss.cssLanguage]) {
    const query = new Parser.Query(language, Scss.HIGHLIGHTS_QUERY);
    const captures = tree =>
      query.captures(tree.rootNode).map(({ name, node }) => [name, node.startIndex, node.endIndex]);
    for (const [before, after] of [
      ["calc", "url"],
      ["calc|a", "calc |a"],
      ["svg|a", "svg||a"],
      ["lang|href", "lang|=href"]
    ]) {
      for (const [from, to] of [
        [before, after],
        [after, before]
      ]) {
        const original =
          before === "calc"
            ? '@namespace calc "urn:test"; calc|a {}'
            : before.startsWith("lang")
              ? ".a[lang|href] {}"
              : `${before} { color: red; }`;
        const source = `${original.replace(before, from)} .next {}`;
        const parser = new Parser();
        const tree = parse(source, parser, undefined, language);
        const start = source.indexOf(from);
        tree.edit({
          startIndex: start,
          oldEndIndex: start + from.length,
          newEndIndex: start + to.length,
          startPosition: { row: 0, column: start },
          oldEndPosition: { row: 0, column: start + from.length },
          newEndPosition: { row: 0, column: start + to.length }
        });
        const edited = source.slice(0, start) + to + source.slice(start + from.length);
        const incremental = parse(edited, parser, tree, language);
        const fresh = parse(edited, new Parser(), undefined, language);
        assert.deepEqual(shape(incremental.rootNode), shape(fresh.rootNode), `${source} -> ${edited}`);
        assert.deepEqual(captures(incremental), captures(fresh));
      }
    }
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
  for (const payload of ["$", "$path"]) {
    const literal = parse(`.a { background: url(${payload}); } .after {}`);
    assert.deepEqual(texts(literal, "variable_name"), []);
    assert.deepEqual(texts(literal, "raw_text"), [payload]);
    assert.equal(literal.rootNode.lastNamedChild.text, ".after {}");
  }
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

test("simple CSS var calls retain ordinary argument nodes without external name tokens", () => {
  const source = `.a { color: var(--text, #333); background: VAR(--bg, transparent);
    border: var(--border); outline: var(--色, #aabbccdd); }`;
  const parser = new Parser();
  const symbols = [];
  parser.setLogger((message, parameters) => {
    if (message === "lexed_lookahead") symbols.push(parameters.sym);
  });
  const cssTree = parse(source, parser);
  assert.ok(symbols.includes("_identifier"));
  assert.ok(!symbols.includes("function_name"));
  const scssTree = parse(source, new Parser(), undefined, Scss);
  assert.equal(cssTree.rootNode.toString(), scssTree.rootNode.toString());
  assert.deepEqual(
    cssTree.rootNode.descendantsOfType("arguments").map(node => node.namedChildren.map(child => child.text)),
    [["--text", "#333"], ["--bg", "transparent"], ["--border"], ["--色", "#aabbccdd"]]
  );
});

test("incremental CSS var edits across simple and raw fallbacks retain fresh trees and captures", () => {
  const query = new Parser.Query(Scss.cssLanguage, Scss.HIGHLIGHTS_QUERY);
  const shape = node => [
    node.type,
    node.startIndex,
    node.endIndex,
    node.children.map((child, index) => [node.fieldNameForChild(index), shape(child)])
  ];
  const captures = tree =>
    query.captures(tree.rootNode).map(({ name, node }) => [name, node.startIndex, node.endIndex]);
  for (const [before, after] of [
    ["#333", "#333, red"],
    ["#333", "#{a:b}"],
    ["#333", "#33"],
    ["#333", "[a;b]"],
    ["#333", "foo({a:b})"],
    ["#333", "red blue"],
    ["#333", String.raw`r\65 d`],
    ["--text", "--text/* comment */"],
    ["--text", "--text#{$suffix}"],
    ["var", "VAR"]
  ]) {
    for (const [from, to] of [
      [before, after],
      [after, before]
    ]) {
      const original = ".a { color: var(--text, #333); padding: 1px; } .next { color: var(--other); }";
      const source = original.replace(before, from);
      const parser = new Parser();
      const tree = parse(source, parser);
      const startIndex = source.indexOf(from);
      tree.edit({
        startIndex,
        oldEndIndex: startIndex + from.length,
        newEndIndex: startIndex + to.length,
        startPosition: { row: 0, column: startIndex },
        oldEndPosition: { row: 0, column: startIndex + from.length },
        newEndPosition: { row: 0, column: startIndex + to.length }
      });
      const edited = source.slice(0, startIndex) + to + source.slice(startIndex + from.length);
      const incremental = parse(edited, parser, tree);
      const fresh = parse(edited);
      assert.deepEqual(shape(incremental.rootNode), shape(fresh.rootNode), edited);
      assert.deepEqual(captures(incremental), captures(fresh), edited);
      assert.equal(incremental.rootNode.lastNamedChild.text, ".next { color: var(--other); }");
    }
  }
});

test("CSS optimizations keep earlier SCSS declarations outside malformed statement recovery", () => {
  const declaration = '$theme: (red blue: 2px, "x": (a: 3px));';
  const parser = new Parser();
  parser.setLanguage(Scss);
  for (const value of ['m"ap.get($theme, "x")', 'm\'ap.get($theme, "x")', 'map."get($theme, "x")']) {
    const tree = parser.parse(`${declaration} .card { margin: ${value}; }\n.after { color: red; }`);
    assert.equal(tree.rootNode.hasError, true);
    assert.equal(tree.rootNode.type, "stylesheet");
    const earlier = tree.rootNode.firstNamedChild;
    assert.equal(earlier.type, "variable_declaration");
    assert.equal(earlier.text, declaration);
    assert.equal(earlier.hasError, false);
  }
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
