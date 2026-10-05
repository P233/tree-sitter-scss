const assert = require("node:assert/strict");
const { test } = require("node:test");
const Parser = require("tree-sitter");
const Scss = require("./index.js");

function shape(node) {
  return [
    node.type,
    node.startIndex,
    node.endIndex,
    node.isMissing,
    node.isExtra,
    ...node.children.map((child, index) => [node.fieldNameForChild(index), shape(child)])
  ];
}

function position(source, index) {
  const lines = source.slice(0, index).split("\n");
  return { row: lines.length - 1, column: lines.at(-1).length };
}

function editAndCompare(parser, query, tree, source, start, end, replacement) {
  const edited = source.slice(0, start) + replacement + source.slice(end);
  tree.edit({
    startIndex: start,
    oldEndIndex: end,
    newEndIndex: start + replacement.length,
    startPosition: position(source, start),
    oldEndPosition: position(source, end),
    newEndPosition: position(edited, start + replacement.length)
  });
  const incremental = parser.parse(edited, tree);
  const fresh = parser.parse(edited);
  if (!fresh.rootNode.hasError) {
    assert.deepEqual(shape(incremental.rootNode), shape(fresh.rootNode), edited);
    const captures = current =>
      query.captures(current.rootNode).map(({ name, node }) => [name, node.startIndex, node.endIndex]);
    assert.deepEqual(captures(incremental), captures(fresh), edited);
  }
  return [incremental, edited];
}

test("query keywords are reclassified when a query call becomes an ordinary call", () => {
  for (const language of [Scss, Scss.cssLanguage]) {
    const parser = new Parser().setLanguage(language);
    const query = new Parser.Query(language, Scss.HIGHLIGHTS_QUERY);
    for (const name of ["media", "supports", "style", "scroll-state", "at-rule"]) {
      for (const word of ["and", "or", "not", "only", "AND", "Only"]) {
        let source = `.a { width: if(${name}(screen ${word} (color)): 1px); }`;
        let tree = parser.parse(source);
        assert.equal(tree.rootNode.hasError, false, source);
        const start = source.indexOf(name);
        [tree, source] = editAndCompare(parser, query, tree, source, start, start + name.length, "foo");
        assert.equal(tree.rootNode.hasError, false, source);
        if (language === Scss.cssLanguage) {
          assert.ok(
            tree.rootNode.descendantsOfType("plain_value").some(node => node.text === word),
            source
          );
        }
        [tree, source] = editAndCompare(parser, query, tree, source, start, start + 3, name);
        assert.equal(tree.rootNode.hasError, false, source);
        assert.ok(
          tree.rootNode.descendantsOfType("operator").some(node => node.text === word),
          source
        );
      }
    }
  }
});

test("numeric boundaries after comment trivia agree across edits and undo", () => {
  for (const language of [Scss, Scss.cssLanguage]) {
    const parser = new Parser().setLanguage(language);
    const query = new Parser.Query(language, Scss.HIGHLIGHTS_QUERY);
    const wrappers = [
      [value => `$x: ${value};`, false],
      [value => `.a { width: ${value}; } .after {}`, false],
      [value => `.a { width: fn(${value}); }`, false]
    ];
    if (language === Scss) wrappers.push([value => `.a { /* #{${value}} */ color: red; } .after {}`, true]);
    for (const [wrap, inComment] of wrappers) {
      const comments = [" /* c */", "/* a */ /* b */", " /* a */ // b\r\n/* c */"];
      // Long comments still participate in numeric token boundaries.
      if (!inComment) comments.push(` /*${"x".repeat(2048)}*/`);
      for (const number of ["1", "1px", "1foo-bar", "1e2", "1e", "1%", "-.5"]) {
        for (const trivia of comments) {
          const original = wrap(`${number}${trivia} + 2`);
          for (const replacement of ["-1", "-.5px", "-$x", "-(1)"]) {
            let source = original;
            let tree = parser.parse(source);
            assert.equal(tree.rootNode.hasError, false, source);
            const start = source.indexOf(" + 2");
            [tree, source] = editAndCompare(parser, query, tree, source, start, start, replacement);
            assert.equal(tree.rootNode.hasError, false, source);
            [tree, source] = editAndCompare(parser, query, tree, source, start, start, " ");
            [tree, source] = editAndCompare(parser, query, tree, source, start, start + 1, "");
            [tree, source] = editAndCompare(parser, query, tree, source, start, start + replacement.length, "");
            assert.equal(source, original);
          }
        }
      }
    }
  }
});

test("editing CSS escape terminators preserves fresh trees and highlights in both dialects", () => {
  for (const language of [Scss, Scss.cssLanguage]) {
    const parser = new Parser();
    parser.setLanguage(language);
    const query = new Parser.Query(language, Scss.HIGHLIGHTS_QUERY);
    for (const original of [
      ".a:l\\61\r\nng(en) {}",
      ".a { width: c\\61\r\nlc(pi); }",
      ".a { color: red !imp\\6f\r\nrtant; }",
      "@m\\65\r\ndia screen { .x\\31\r\nb {} }"
    ]) {
      for (const start of [original.indexOf("\r"), original.indexOf("\n")]) {
        for (const replacement of ["", " ", "\r\n", "\n\n"]) {
          let source = original;
          let tree = parser.parse(source);
          [tree, source] = editAndCompare(parser, query, tree, source, start, start + 1, replacement);
          [tree, source] = editAndCompare(
            parser,
            query,
            tree,
            source,
            start,
            start + replacement.length,
            original[start]
          );
          assert.equal(source, original);
        }
      }
    }
  }
});

test("complete multiline selectors and values retain their contexts", () => {
  const parser = new Parser();
  for (const language of [Scss, Scss.cssLanguage]) {
    parser.setLanguage(language);
    const star = parser.parse(".a { *zoom: 1; *\n zoom: 2; * zoom: 3; }\n*\n a {}").rootNode;
    assert.equal(star.hasError, false);
    assert.equal(star.descendantsOfType("property_declaration").length, 3);
    assert.equal(star.lastNamedChild.childForFieldName("selectors").text, "*\n a");
    // A line break inside a statement is whitespace, so this reads as the complex selector Sass refuses to extend.
    const extend = parser.parse(`.a {\n  @extend .b\n    .c;\n}\n.after {}\n`).rootNode;
    assert.equal(extend.hasError, false);
    assert.equal(extend.namedChildCount, 2);
    assert.equal(extend.descendantsOfType("extend_statement")[0].descendantsOfType("complex_selector").length, 1);
    // A selector still continues on later lines when its block follows, with long trivia.
    for (const selector of [
      ".b\n.c",
      ".b\n  c\n  d",
      ":is(.b\n  .c)",
      ".b // note\n  .c",
      '.b\n  c#{map-get($m, "}")}',
      ".b\n  c#{\n    $x\n  }",
      `.b\n  ${".c, ".repeat(400)}.d`,
      `.b${"\n  :c".repeat(128)}\n  /* ${"x".repeat(1 << 20)} */`
    ]) {
      const root = parser.parse(`.a {\n  ${selector} { color: red; }\n}`).rootNode;
      assert.equal(root.hasError, false, selector);
      assert.equal(root.descendantsOfType("complex_selector").length, 1, selector);
    }
    // Groups, CSS if() branches, value lists and raw values may still continue onto declaration-like lines.
    for (const source of [
      "@if $a ==\n  $b { .x { y: z; } }",
      "@supports (\n  display: grid\n) { .x { y: z; } }",
      "@mixin m($a,\n  $b: 1px) { b: $a; }",
      "@media screen and (min-width: 1px),\n  print { .x { y: z; } }",
      "@each $k, $v in (\n  a: 1,\n  b: 2\n) { .x { w: $v; } }",
      "@while $i >\n  0 { .x { y: z; } }",
      "$m: (\n  key: value,\n  other: 1\n);",
      ".a {\n  width: if(\n    style(--x): 1px;\n    else: 2px;\n  );\n}",
      ".a {\n  transition:\n    opacity 1s,\n    transform 1s;\n}",
      ":root {\n  --a: #fde>\n  --b: #f2b8b0;\n}",
      '.a {\n  background: url(\n    "a.png"\n  );\n}',
      ".a {\n  background: url(\n    data: x;\n  );\n}"
    ]) {
      assert.equal(parser.parse(source).rootNode.hasError, false, source);
    }
  }
});
