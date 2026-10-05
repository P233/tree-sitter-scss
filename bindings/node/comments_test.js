const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const { test } = require("node:test");
const Parser = require("tree-sitter");
const Scss = require("./index.js");

function parse(source, language = Scss) {
  const parser = new Parser();
  parser.setLanguage(language);
  const tree = parser.parse(source);
  assert.equal(tree.rootNode.hasError, false, `${source}\n${tree.rootNode.toString()}`);
  return tree;
}

test("expression and selector comments keep interpolation-like text literal", () => {
  for (const language of [Scss, Scss.cssLanguage]) {
    const query = new Parser.Query(language, Scss.HIGHLIGHTS_QUERY);
    for (const comment of ["/* #{ */", "/* #{$unfinished */", "/* #{$ignored} */", "/*! #{$ignored} */"]) {
      for (const template of [
        ".a { color: red COMMENT; }",
        ".a { color: red COMMENT }",
        ".a { width: COMMENT 10px; }",
        ".a { width: 1foo-bar COMMENT; }",
        ".a { --raw: COMMENT red; }",
        ".a COMMENT .b { color: red; }",
        "$x: 1 COMMENT + 2; .a { width: $x; }",
        ".a { width: foo(COMMENT 1px); }",
        "@mixin m($x COMMENT) { width: $x; } .a { @include m(1px); }",
        ".a { width: #{1 COMMENT + 2}px; }"
      ]) {
        const source = `${template.replace("COMMENT", comment)} .sentinel { color: red; }`;
        const tree = parse(source, language);
        const [node] = tree.rootNode.descendantsOfType("block_comment");
        assert.equal(node.text, comment, source);
        assert.deepEqual(node.descendantsOfType("interpolation"), [], source);
        assert.deepEqual(
          query.captures(node).map(({ name }) => name),
          ["comment"],
          source
        );
        assert.equal(tree.rootNode.lastNamedChild.text, ".sentinel { color: red; }");
      }
    }
  }
});

test("statement comments retain interpolation as block content", () => {
  for (const source of [
    "/* #{1 + 2} */ .a {}",
    ".a { /* #{1 + 2} */ }",
    ".a { color: red; /* #{1 + 2} */ width: 1px; }",
    "@mixin m { /* #{1 + 2} */ color: red; }",
    "@function f() { /* #{1 + 2} */ @return 1; }",
    "@function --f() { /* #{1 + 2} */ result: 1; }",
    "@future { /* #{1 + 2} */ anything(x); }",
    "@if true {} /* #{1 + 2} */",
    "@if true {} /* #{1 + 2} */ .a {}"
  ]) {
    const root = parse(source).rootNode;
    assert.deepEqual(
      root.descendantsOfType("interpolation").map(node => node.text),
      ["#{1 + 2}"],
      source
    );
    assert.deepEqual(
      root
        .descendantsOfType("number")
        .slice(0, 2)
        .map(node => node.text),
      ["1", "2"],
      source
    );
  }
  const rule = parse(".a { /* #{1 + 2} */ }").rootNode.firstNamedChild;
  assert.equal(rule.childForFieldName("body").text, "/* #{1 + 2} */");
  const declaration = parse(".a { color: red /* #{$ignored} */ blue; }").rootNode.descendantsOfType(
    "property_declaration"
  )[0];
  assert.deepEqual(
    declaration.childrenForFieldName("value").map(node => node.text),
    ["red", "blue"]
  );
});

test("direct braces bound complete blocks independently of comment grouping", () => {
  for (const language of [Scss, Scss.cssLanguage]) {
    for (const [source, interior] of [
      [".a { /* lead */ color: red; }", " /* lead */ color: red; "],
      [".a { color: red; /* trail */ }", " color: red; /* trail */ "],
      [".a { color: red; // trail\n}", " color: red; // trail\n"],
      [".a { color: red; /* trail */ // trail\n}", " color: red; /* trail */ // trail\n"],
      [".a { color: red; // trail\n /* trail */ }", " color: red; // trail\n /* trail */ "],
      [".a { color: red /* final */ }", " color: red /* final */ "],
      [".a { /* only */ }", " /* only */ "],
      [".a {}", ""],
      ['.a { content: "}"; .b { x: 1; } /* { */ }', ' content: "}"; .b { x: 1; } /* { */ '],
      ["@media screen { .b {} /* trail */ }", " .b {} /* trail */ "],
      ["@mixin m { color: red; /* trail */ }", " color: red; /* trail */ "],
      ["@function --f() { result: 1; /* trail */ }", " result: 1; /* trail */ "],
      ["@future { anything(x); /* trail */ }", " anything(x); /* trail */ "]
    ]) {
      const owner = parse(source, language).rootNode.firstNamedChild;
      const braces = owner.children.filter(node => node.type === "{" || node.type === "}");
      assert.deepEqual(
        braces.map(node => node.type),
        ["{", "}"],
        source
      );
      assert.equal(source.slice(braces[0].endIndex, braces[1].startIndex), interior, source);
    }
  }
  const rule = parse(".a { /* a */ color: red; /* b */ width: 1px; /* #{1} */ }").rootNode.firstNamedChild;
  assert.equal(rule.childForFieldName("body").text, "/* a */ color: red; /* b */ width: 1px; /* #{1} */");
  assert.equal(rule.descendantsOfType("interpolation").length, 1);
});

test("apparent comments in strings and URLs keep their own interpolation", () => {
  const root = parse('.a { content: "/* #{1 + 2} */"; image: url(foo/*#{1 + 2}*/); }').rootNode;
  assert.deepEqual(root.descendantsOfType("block_comment"), []);
  assert.deepEqual(
    root.descendantsOfType("interpolation").map(node => node.text),
    ["#{1 + 2}", "#{1 + 2}"]
  );
  const afterIf = parse("@if true {} /* #{1} */ @elsewhere {}").rootNode;
  assert.equal(afterIf.descendantsOfType("else_clause").length, 0);
  assert.equal(afterIf.descendantsOfType("interpolation").length, 1);
});

test("line comments keep interpolation-like text literal in both dialects", () => {
  for (const language of [Scss, Scss.cssLanguage]) {
    for (const content of ["#{1 + 2}", "#{$unfinished", "#{"]) {
      for (const source of [
        `// ${content}\n.a { color: red; }`,
        `.a { // ${content}\ncolor: red; }`,
        `.a { color: red; // ${content}\nwidth: 1px; }`
      ]) {
        const root = parse(source, language).rootNode;
        assert.deepEqual(root.descendantsOfType("interpolation"), [], source);
        assert.equal(root.descendantsOfType("inline_comment")[0].text, `// ${content}`);
      }
    }
  }
});

test("comment terminators inside interpolation strings, URLs and nested comments keep their context", () => {
  for (const expression of [
    '"*/"',
    "url(foo*/bar)",
    "URL(foo*/bar)",
    "Url(foo*/bar)",
    "1 /* nested */ + 2",
    "1 /* nested */ + if(media((color)): 2; else: 3)",
    "1 /* nested */ + url(foo;bar)",
    'fn("*/", 1 * 2)'
  ]) {
    const source = `.a { /* #{${expression}} */ color: red; } .next {}`;
    const root = parse(source).rootNode;
    assert.equal(root.descendantsOfType("interpolation")[0].text, `#{${expression}}`);
    assert.equal(root.descendantsOfType("block_comment")[0].text, `/* #{${expression}} */`);
    assert.equal(root.descendantsOfType("property_declaration")[0].text, "color: red;");
    assert.equal(root.lastNamedChild.text, ".next {}");
  }
});

test("comments before else clauses stay literal and keep the branches attached", () => {
  for (const comment of ["/* #{ */", "/* #{$ignored} */", "/* one */ // two\n/* #{$ignored} */"]) {
    for (const branch of ["@else if", "@elseif"]) {
      const root = parse(`@if true {} ${comment} ${branch} false {} ${comment} @else {} .after {}`).rootNode;
      assert.deepEqual(
        root.namedChildren.map(node => node.type),
        ["if_statement", "rule_set"]
      );
      assert.equal(root.descendantsOfType("else_clause").length, 2);
      assert.deepEqual(root.descendantsOfType("interpolation"), []);
    }
  }
});

test("CSS comment interpolation stays literal and preserves following declarations", () => {
  for (const language of [Scss.cssLanguage]) {
    const query = new Parser.Query(language, Scss.HIGHLIGHTS_QUERY);
    for (const comment of [
      "/* #{ */",
      "/* #{$unfinished */",
      "/* #{1 + */",
      "/* #{fn(1 */",
      "/* #{fn(1} */",
      "/* #{(1 + 2 */",
      "/* #{[1 2} */",
      "/* #{(1 + 2) */",
      '/* #{"}" */',
      '/* #{"unterminated */',
      "/* #{1 \\} */",
      "/* #{URL(foo}bar) */",
      "/* #{Url(foo}bar) */",
      "/* $unopened} */"
    ]) {
      for (const source of [`${comment} .next {}`, `.a { ${comment} color: red; width: 1px; } .next {}`]) {
        const root = parse(source, language).rootNode;
        const node = root.descendantsOfType("block_comment")[0];
        assert.equal(node.text, comment, source);
        assert.deepEqual(node.descendantsOfType("interpolation"), [], source);
        assert.deepEqual(
          query.captures(node).map(({ name }) => name),
          ["comment"],
          source
        );
        assert.equal(root.lastNamedChild.text, ".next {}", source);
        if (source.startsWith(".a")) {
          assert.deepEqual(
            root.descendantsOfType("property_declaration").map(node => node.text),
            ["color: red;", "width: 1px;"],
            source
          );
        }
      }
    }
  }
});

test("paired comment interpolation still parses its expression syntax", () => {
  const parser = new Parser();
  parser.setLanguage(Scss);
  for (const expression of ["", "1 ^ 2"]) {
    const source = `/* #{${expression}} */ .next {}`;
    const root = parser.parse(source).rootNode;
    assert.equal(root.hasError, true, source);
    assert.equal(root.descendantsOfType("interpolation")[0].text, `#{${expression}}`, source);
    assert.equal(root.lastNamedChild.text, ".next {}");
  }
});

test("comment interpolation may continue on later lines inside its own expression", () => {
  for (const expression of ['fn(\n    "a"\n  )', "\n    $a\n  ", " a // note\n  "]) {
    const comment = `/* #{${expression}} */`;
    const root = parse(`.a {\n  ${comment}\n  color: red;\n}\n.after {}`).rootNode;
    assert.equal(root.descendantsOfType("block_comment")[0].text, comment);
    assert.equal(root.descendantsOfType("interpolation")[0].text, `#{${expression}}`);
    assert.equal(root.descendantsOfType("property_declaration")[0].text, "color: red;");
    assert.equal(root.lastNamedChild.text, ".after {}");
  }
});

test("complete string interpolation retains nested quotes and multiline expressions", () => {
  for (const [value, count] of [
    ['"#{$a}"', 1],
    ['"a #{"b"} c"', 1],
    ["'a #{\"b\"} c'", 1],
    ['"#{"}"}"', 1],
    ['"#{\n  $a\n} tail"', 1],
    ['"#{\n  $a\n} #{\n  $b\n}"', 2],
    ['"#{$a /*\n*/}"', 1],
    ['url("#{$path}/img.png")', 1]
  ]) {
    const root = parse(`.a { content: ${value}; } .after {}`).rootNode;
    assert.equal(root.descendantsOfType("interpolation").length, count, value);
    assert.equal(root.lastNamedChild.text, ".after {}");
  }
});

test("complete comment interpolation has no lookahead window", () => {
  for (const expression of [
    "a ".repeat(2000),
    `// ${"x".repeat(2000)}\n1`,
    `/* ${"x".repeat(2000)} */ 1`,
    "if(media((color)): 2; else: 3)"
  ]) {
    const comment = `/* #{${expression}} */`;
    const root = parse(`.a { ${comment} color: red; } .after {}`).rootNode;
    assert.equal(root.descendantsOfType("block_comment")[0].text, comment);
    assert.equal(root.descendantsOfType("interpolation")[0].text, `#{${expression}}`);
    assert.equal(root.lastNamedChild.text, ".after {}");
  }
});

test("deep malformed interpolation terminates without overflowing the native stack", () => {
  const result = spawnSync(
    process.execPath,
    [
      "-e",
      `const assert = require("node:assert/strict");
       const Parser = require("tree-sitter");
       const Scss = require(${JSON.stringify(require.resolve("./index.js"))});
       const parser = new Parser();
       parser.setLanguage(Scss);
       for (const unit of ['#{"', '#{url(', '#{"a"']) {
         const source = '.a { /* ' + unit.repeat(100000) + ' */ color: red; } .after {}';
         const root = parser.parse(source).rootNode;
         assert.equal(root.endIndex, source.length);
       }
       for (const unit of ['#{"', '#{url(']) {
         const source = '.a :hover#{' + unit.repeat(10000) + ' {}';
         assert.equal(parser.parse(source).rootNode.endIndex, source.length);
       }`
    ],
    { encoding: "utf8", timeout: 15000, maxBuffer: 1024 * 1024 }
  );
  assert.equal(result.error, undefined, String(result.error));
  assert.equal(result.signal, null, result.stderr);
  assert.equal(result.status, 0, result.stderr);
});

test("complete nested interpolation is not limited by scanner lookahead", () => {
  for (const [open, close] of [
    ["#{", "}"],
    ['#{"', '"}']
  ]) {
    for (const depth of [12, 16, 24, 1000]) {
      const root = parse(`/* ${open.repeat(depth)}value${close.repeat(depth)} */ .after {}`).rootNode;
      assert.equal(root.descendantsOfType("interpolation").length, depth);
      assert.equal(root.lastNamedChild.text, ".after {}");
    }
  }
});

test("closing comment interpolation restores fresh nodes and highlights", () => {
  const shape = node => [node.type, node.startIndex, node.endIndex, node.isMissing, ...node.children.map(shape)];
  for (const language of [Scss, Scss.cssLanguage]) {
    const parser = new Parser();
    parser.setLanguage(language);
    const query = new Parser.Query(language, Scss.HIGHLIGHTS_QUERY);
    const captures = tree =>
      query.captures(tree.rootNode).map(({ name, node }) => [name, node.startIndex, node.endIndex]);
    const source = ".a { /* #{1 + 2} */ color: red; } .next {}";
    const start = source.indexOf("}");
    let tree = parser.parse(source);
    for (const remove of [true, false]) {
      const edited = remove ? source.slice(0, start) + source.slice(start + 1) : source;
      tree.edit({
        startIndex: start,
        oldEndIndex: start + (remove ? 1 : 0),
        newEndIndex: start + (remove ? 0 : 1),
        startPosition: { row: 0, column: start },
        oldEndPosition: { row: 0, column: start + (remove ? 1 : 0) },
        newEndPosition: { row: 0, column: start + (remove ? 0 : 1) }
      });
      tree = parser.parse(edited, tree);
      if (remove && language === Scss) continue;
      const fresh = parser.parse(edited);
      assert.deepEqual(shape(tree.rootNode), shape(fresh.rootNode));
      assert.deepEqual(captures(tree), captures(fresh));
      assert.equal(tree.rootNode.hasError, false);
      assert.equal(tree.rootNode.descendantsOfType("interpolation").length, language === Scss && !remove ? 1 : 0);
      assert.equal(tree.rootNode.descendantsOfType("property_declaration")[0].text, "color: red;");
      assert.equal(tree.rootNode.lastNamedChild.text, ".next {}");
    }
  }
});

test("repairing an unfinished comment restores syntax and capture ranges", () => {
  for (const language of [Scss, Scss.cssLanguage]) {
    const parser = new Parser();
    parser.setLanguage(language);
    const source = ".a { color: red /* #{ */; } .next {}";
    const start = source.indexOf("*/") + 1;
    const tree = parser.parse(source);
    tree.edit({
      startIndex: start,
      oldEndIndex: start + 1,
      newEndIndex: start,
      startPosition: { row: 0, column: start },
      oldEndPosition: { row: 0, column: start + 1 },
      newEndPosition: { row: 0, column: start }
    });
    const unfinished = parser.parse(source.slice(0, start) + source.slice(start + 1), tree);
    assert.equal(unfinished.rootNode.hasError, true);
    unfinished.edit({
      startIndex: start,
      oldEndIndex: start,
      newEndIndex: start + 1,
      startPosition: { row: 0, column: start },
      oldEndPosition: { row: 0, column: start },
      newEndPosition: { row: 0, column: start + 1 }
    });
    const incremental = parser.parse(source, unfinished);
    const fresh = parse(source, language);
    assert.equal(incremental.rootNode.hasError, false);
    assert.equal(incremental.rootNode.toString(), fresh.rootNode.toString());
    assert.equal(incremental.rootNode.lastNamedChild.text, ".next {}");
    const query = new Parser.Query(language, Scss.HIGHLIGHTS_QUERY);
    const captures = tree =>
      query.captures(tree.rootNode).map(({ name, node }) => [name, node.startIndex, node.endIndex]);
    assert.deepEqual(captures(incremental), captures(fresh));
  }
});

test("repairing a damaged branch reattaches else clauses across comments", () => {
  for (const language of [Scss, Scss.cssLanguage]) {
    const original = "@if true {} /* #{1} */ @else if false {} /* #{2} */ @else {} .next {}";
    const parser = new Parser();
    parser.setLanguage(language);
    let source = original;
    let tree = parser.parse(source);
    for (const edited of [
      "@if true {} /* #{1} */ @el/* */false {} /* #{2} */ @else {} .next {}",
      "@if true {} /* #{1} */ @el/* if false {} /* #{2} */ @else {} .next {}",
      original
    ]) {
      let start = 0;
      while (start < source.length && source[start] === edited[start]) start++;
      let oldEnd = source.length;
      let newEnd = edited.length;
      while (oldEnd > start && newEnd > start && source[oldEnd - 1] === edited[newEnd - 1]) {
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
      tree = parser.parse(edited, tree);
      source = edited;
    }
    const fresh = parse(original, language);
    assert.equal(tree.rootNode.hasError, false);
    assert.equal(tree.rootNode.toString(), fresh.rootNode.toString());
    assert.equal(tree.rootNode.descendantsOfType("else_clause").length, 2);
    assert.equal(tree.rootNode.descendantsOfType("interpolation").length, 0);
    assert.equal(tree.rootNode.firstNamedChild.text, original.slice(0, original.indexOf(" .next")));
    const query = new Parser.Query(language, Scss.HIGHLIGHTS_QUERY);
    const captures = tree =>
      query.captures(tree.rootNode).map(({ name, node }) => [name, node.startIndex, node.endIndex]);
    assert.deepEqual(captures(tree), captures(fresh));
  }
});

test("incremental comment context changes preserve fresh nodes and captures", () => {
  const shape = node => [node.type, node.startIndex, node.endIndex, node.isMissing, ...node.children.map(shape)];
  for (const language of [Scss, Scss.cssLanguage]) {
    const query = new Parser.Query(language, Scss.HIGHLIGHTS_QUERY);
    const captures = tree =>
      query.captures(tree.rootNode).map(({ name, node }) => [name, node.startIndex, node.endIndex]);
    for (const [before, after] of [
      [".a { color: red /* #{1} */ } .next {}", ".a { color: red; /* #{1} */ } .next {}"],
      ["@if true {} /* #{1} */ .next {}", "@if true {} /* #{1} */ @else {} .next {}"],
      [".a { /* #{1} */ } .next {}", ".a { x: /* #{1} */ 1; } .next {}"],
      [".a { width: #{1 /* #{ */ + 2}px; } .next {}", ".a { width: #{1 /* #{3} */ + 2}px; } .next {}"],
      [".a { color: red; /* #{1} */ width: 1px; } .next {}", ".a { color: red; /* #{1} */ } .next {}"],
      [".a { color: red; /* #{1} */ } .next {}", ".a { /* #{1} */ } .next {}"],
      [".a { color: red; // line\n} .next {}", ".a { color: red; // line\n /* #{1} */ } .next {}"],
      [".a { color: red; /* #{1} */ // line\n} .next {}", ".a { color: red; /* #{1} */ // line\n x: 1; } .next {}"]
    ]) {
      for (const [source, edited] of [
        [before, after],
        [after, before]
      ]) {
        const parser = new Parser();
        parser.setLanguage(language);
        const tree = parser.parse(source);
        let start = 0;
        while (start < source.length && source[start] === edited[start]) start++;
        let oldEnd = source.length;
        let newEnd = edited.length;
        while (oldEnd > start && newEnd > start && source[oldEnd - 1] === edited[newEnd - 1]) {
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
        const incremental = parser.parse(edited, tree);
        const fresh = parse(edited, language);
        assert.deepEqual(shape(incremental.rootNode), shape(fresh.rootNode), `${source} -> ${edited}`);
        assert.deepEqual(captures(incremental), captures(fresh), `${source} -> ${edited}`);
      }
    }
  }
});
