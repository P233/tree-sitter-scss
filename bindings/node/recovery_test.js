const assert = require("node:assert/strict");
const { test } = require("node:test");
const Parser = require("tree-sitter");
const Scss = require("./index.js");
const { effectiveCaptures } = require("./highlight_roles.js");

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

// Paint outer ranges first so the innermost effective capture owns each character.
function highlightRoles(captures, source) {
  const roles = new Array(source.length);
  const outerFirst = captures.toSorted(
    (a, b) => b.node.endIndex - b.node.startIndex - (a.node.endIndex - a.node.startIndex)
  );
  for (const { name, node } of outerFirst) roles.fill(name, node.startIndex, node.endIndex);
  return roles;
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
  assert.deepEqual(shape(incremental.rootNode), shape(fresh.rootNode), edited);
  const captures = current =>
    query.captures(current.rootNode).map(({ name, node }) => [name, node.startIndex, node.endIndex]);
  assert.deepEqual(captures(incremental), captures(fresh), edited);
  return [incremental, edited];
}

function assertScope(root, source) {
  assert.equal(root.hasError, true, source);
  assert.equal(root.firstNamedChild.type, "mixin_definition", root.toString());
  assert.equal(root.firstNamedChild.childForFieldName("parameters").text, "($tone)", source);
  assert.equal(root.lastNamedChild.type, "rule_set", root.toString());
  assert.equal(root.lastNamedChild.text, ".after {}", source);
}

test("unfinished headers retain existing selector and function highlight roles", () => {
  const cases = [
    ["a b*{}", [["tag", "*"]]],
    ["a b&{}", [["tag", "&"]]],
    [
      "@supports selector(:s(a,*",
      [
        ["function", "selector"],
        ["attribute", "s"],
        ["tag", "*"]
      ]
    ],
    ["@function --f({@media{{}", [["function", "--f"]]],
    ["a{;;:nth-child(2n+1\n}", [["number", "2n+1"]]]
  ];
  for (const language of [Scss, Scss.cssLanguage]) {
    const parser = new Parser().setLanguage(language);
    const query = new Parser.Query(language, Scss.HIGHLIGHTS_QUERY);
    for (const [source, expected] of cases) {
      const tree = parser.parse(source);
      assert.equal(tree.rootNode.hasError, true, source);
      const captures = effectiveCaptures(query, tree.rootNode);
      const roles = highlightRoles(captures, source);
      for (const [role, text] of expected) {
        const capture = captures.find(({ name, node }) => name === role && node.text === text);
        assert.ok(capture, `${language.name}: ${source}: missing ${role} on ${text}`);
        assert.deepEqual(
          roles.slice(capture.node.startIndex, capture.node.endIndex),
          new Array(text.length).fill(role),
          `${language.name}: ${source}: overridden ${role} on ${text}`
        );
      }
    }
  }
});

test("damaged raw interpolation preserves following delimiter highlight roles", () => {
  const source = ".a{--x:#{m.#{x};x;} a.a{}";
  for (const language of [Scss, Scss.cssLanguage]) {
    const parser = new Parser().setLanguage(language);
    const query = new Parser.Query(language, Scss.HIGHLIGHTS_QUERY);
    const tree = parser.parse(source);
    assert.equal(tree.rootNode.hasError, true);
    const roles = highlightRoles(effectiveCaptures(query, tree.rootNode), source);
    assert.equal(roles[source.indexOf("} a.a")], "punctuation.bracket");
    // CSS keeps interpolation literal inside a raw group; SCSS retains the later selector delimiter.
    assert.equal(roles[source.lastIndexOf(".")], language === Scss ? "punctuation.delimiter" : "string");
    assert.equal(roles[source.length - 1], "punctuation.bracket");
  }
});

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
      // Long numeric dependencies are independent of text-host interpolation's pairing budget.
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

test("unfinished else heads recover inside their enclosing block", () => {
  for (const language of [Scss, Scss.cssLanguage]) {
    const parser = new Parser();
    parser.setLanguage(language);
    const query = new Parser.Query(language, Scss.HIGHLIGHTS_QUERY);
    for (const gap of [" ", " /* note */ ", " // note\n "]) {
      for (const head of ["@else", "@else if", "@else if $tone", "@elseif $tone"]) {
        let source = `@mixin paint($tone) { @if true {}${gap}${head} } .after {}`;
        let tree = parser.parse(source);
        assertScope(tree.rootNode, source);
        assert.equal(tree.rootNode.descendantsOfType("if_statement").length, 1, source);
        const insertion = source.lastIndexOf(" } .after");
        const completion = head.endsWith(" if") ? " $tone {}" : " {}";
        [tree, source] = editAndCompare(parser, query, tree, source, insertion, insertion, completion);
        assert.equal(tree.rootNode.hasError, false, source);
        assert.equal(tree.rootNode.descendantsOfType("else_clause").length, 1, source);
        [tree, source] = editAndCompare(parser, query, tree, source, insertion, insertion + completion.length, "");
        assertScope(tree.rootNode, source);
      }
    }
  }
});

test("unfinished variables skip comment trivia only to an existing value boundary", () => {
  for (const language of [Scss, Scss.cssLanguage]) {
    const parser = new Parser();
    parser.setLanguage(language);
    const query = new Parser.Query(language, Scss.HIGHLIGHTS_QUERY);
    for (const comment of ["/*c*/", " /*c*/ ", "//c\n", " /*a*/ //b\r\n /*c*/ "]) {
      for (const value of ["$COMMENT;", "fn($COMMENT);", "[$COMMENT];", "fn($COMMENT, 1);", "$COMMENT"]) {
        let source = `@mixin paint($tone) { @mixin inner($inner) {} color: ${value.replace("COMMENT", comment)} } .after {}`;
        let tree = parser.parse(source);
        assertScope(tree.rootNode, source);
        assert.equal(tree.rootNode.descendantsOfType("mixin_definition").length, 2, source);
        assert.equal(tree.rootNode.descendantsOfType("property_name")[0].text, "color", source);
        const insertion = source.lastIndexOf("$") + 1;
        [tree, source] = editAndCompare(parser, query, tree, source, insertion, insertion, "tone");
        assert.equal(tree.rootNode.hasError, false, source);
        [tree, source] = editAndCompare(parser, query, tree, source, insertion, insertion + 4, "");
        assertScope(tree.rootNode, source);
      }
      const invalid = `@mixin paint($tone) { color: $${comment}name; } .after {}`;
      const root = parser.parse(invalid).rootNode;
      assert.equal(root.hasError, true, invalid);
      assert.ok(!root.descendantsOfType("variable_name").some(node => node.text.includes(comment)), invalid);
    }
  }
});

test("unfinished variables preserve scope before priorities and control-flow boundaries", () => {
  for (const language of [Scss, Scss.cssLanguage]) {
    const parser = new Parser();
    parser.setLanguage(language);
    const query = new Parser.Query(language, Scss.HIGHLIGHTS_QUERY);
    for (const statement of [
      "color: $ !important;",
      "$color: $ !default;",
      "@each $ in $list {}",
      "@each $first, $ in $list {}",
      "@for $ from 1 through 3 {}",
      "@if $ { color: red; }",
      "@while $ { color: red; }",
      "color: $ foo;",
      "width: $ + 1px;",
      "@for $i from $ through 3 {}"
    ]) {
      for (const gap of [" ", "/* note */", " /* note */ ", " // note\n "]) {
        const fragment = statement.replace("$ ", `$${gap}`);
        let source = `@mixin paint($tone) { ${fragment} } .after {}`;
        let tree = parser.parse(source);
        assertScope(tree.rootNode, source);
        const insertion = source.indexOf(`$${gap}`) + 1;
        [tree, source] = editAndCompare(parser, query, tree, source, insertion, insertion, "tone");
        assert.equal(tree.rootNode.hasError, false, source);
        [tree, source] = editAndCompare(parser, query, tree, source, insertion, insertion + 4, "");
        assertScope(tree.rootNode, source);
      }
    }
    for (const name of ["in", "from", "inside", "fromage", "name"]) {
      for (const gap of [" ", "/* note */", " /* note */", "/* note */ "]) {
        const source = `@mixin paint($tone) { color: $${gap}${name}; } .after {}`;
        const root = parser.parse(source).rootNode;
        assert.equal(root.hasError, true, source);
        assert.ok(!root.descendantsOfType("variable_name").some(node => node.text.includes(gap)), source);
      }
    }
  }
});

test("unfinished string interpolation stays string text and preserves following rules", () => {
  for (const language of [Scss, Scss.cssLanguage]) {
    const parser = new Parser();
    parser.setLanguage(language);
    const query = new Parser.Query(language, Scss.HIGHLIGHTS_QUERY);
    // A host quote inside the expression ends a literal host string early.
    for (const [value, first] of [
      ['"a #{$b c"', '"a #{$b c"'],
      ["'a #{$b c'", "'a #{$b c'"],
      ['"#{#{#{"', '"#{#{#{"'],
      ['"a #{"b" c"', '"a #{"']
    ]) {
      for (const source of [`.a { content: ${value}; } .after {}`, `.a {\n  content: ${value};\n}\n.after {}`]) {
        const root = parser.parse(source).rootNode;
        assert.equal(root.hasError, false, source);
        assert.equal(root.descendantsOfType("string")[0].text, first, source);
        assert.deepEqual(root.descendantsOfType("interpolation"), [], source);
        assert.equal(root.lastNamedChild.text, ".after {}", source);
      }
    }
    // A literal host string also ends at a line break, so an opener cannot take the block's brace.
    for (const value of ['"#{$a', "'#{$a", '"#{fn($a)', '"a #{$b c']) {
      for (const body of ["", "\n  $b", "\n  width: 1px"]) {
        const source = `.a {\n  content: ${value}${body}\n}\n.after {}`;
        const root = parser.parse(source).rootNode;
        assert.deepEqual(root.descendantsOfType("interpolation"), [], source);
        assert.equal(root.firstNamedChild.type, "rule_set", source);
        assert.equal(root.lastNamedChild.text, ".after {}", source);
      }
    }
    // Nested quotes are Sass syntax; CSS reads these texts as different strings.
    const paired = language === Scss ? ['"#{$a}"', '"a #{"b"} c"', "'a #{\"b\"} c'", '"#{"}"}"'] : [];
    for (const value of [...paired, 'url("#{$path}/img.png")']) {
      const root = parser.parse(`.a { content: ${value}; } .after {}`).rootNode;
      assert.equal(root.hasError, false, value);
      assert.equal(root.descendantsOfType("interpolation").length, language === Scss ? 1 : 0, value);
    }
    if (language === Scss) {
      // Only an interpolation carries a string past a line break.
      for (const [value, count] of [
        ['"#{\n  $a\n}"', 1],
        ['"#{\n  $a\n} tail"', 1],
        ['"#{\n  $a\n} #{\n  $b\n}"', 2],
        ['"#{$a /*\n*/}"', 1]
      ]) {
        const root = parser.parse(`.a { content: ${value}; } .after {}`).rootNode;
        assert.equal(root.hasError, false, value);
        assert.equal(root.descendantsOfType("interpolation").length, count, value);
      }
    }
    let source = '.a { content: "a #{$b c"; } .after {}';
    let tree = parser.parse(source);
    const insertion = source.indexOf(' c"');
    [tree, source] = editAndCompare(parser, query, tree, source, insertion, insertion, "}");
    assert.equal(tree.rootNode.descendantsOfType("interpolation").length, language === Scss ? 1 : 0, source);
    [tree, source] = editAndCompare(parser, query, tree, source, insertion, insertion + 1, "");
    assert.deepEqual(tree.rootNode.descendantsOfType("interpolation"), [], source);
    assert.equal(tree.rootNode.lastNamedChild.text, ".after {}");
  }
});

test("comment prefix lookahead is invalidated when delimiters or URL spellings change", () => {
  for (const language of [Scss, Scss.cssLanguage]) {
    const parser = new Parser();
    parser.setLanguage(language);
    const query = new Parser.Query(language, Scss.HIGHLIGHTS_QUERY);
    for (const comment of [
      "#{ #{ #{1}",
      "#{\r\n#{\r\n#{1}",
      `${"#{".repeat(128)}1}}`,
      '#{"a" #{"b" #{1}',
      "#{url(#{url(#{1}",
      '#{"#{1}" #{unfinished',
      String.raw`#{"\#{1}" #{unfinished`,
      String.raw`#{url(\#{1}) #{unfinished`,
      String.raw`#{name\#{1} #{unfinished`,
      "#{1 /* #{ignored}",
      "#{https://example.test */\n color: red; } .next { /* tail",
      "#{URL(foo}bar)",
      "#{URL(foo*/bar)}"
    ]) {
      if (language === Scss.cssLanguage && comment.includes("foo*/")) continue;
      const original = `.a { /* ${comment} */ color: red; } .after {}`;
      for (let start = original.indexOf("#{"); start < original.lastIndexOf("*/"); start++) {
        for (const replacement of ["}", '"', "/*", ""]) {
          let source = original;
          let tree = parser.parse(source);
          const end = start + (replacement === "" ? 1 : 0);
          [tree, source] = editAndCompare(parser, query, tree, source, start, end, replacement);
          [tree, source] = editAndCompare(
            parser,
            query,
            tree,
            source,
            start,
            start + replacement.length,
            original.slice(start, end)
          );
          assert.equal(source, original);
          assert.equal(tree.rootNode.hasError, false, original);
          assert.equal(tree.rootNode.lastNamedChild.text, ".after {}");
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

test("a statement typed above a declaration ends at its own line", () => {
  const parser = new Parser();
  // Enough later nodes for the runtime to settle on one recovery, as in a real file.
  const tail = Array.from({ length: 300 }, (_, index) => `.t${index} { margin: ${index}px; }`).join("\n");
  for (const language of [Scss, Scss.cssLanguage]) {
    parser.setLanguage(language);
    for (const prefix of ["c", "color", "m10", ".b", "&-x", "&", "#id", "[data-x]", ".b.c", ".b:hover", "&:is(.c)"]) {
      const source = `.a {\n  color: red;\n  ${prefix}\n  width: 1px;\n}\n.y {\n  color: blue;\n}\n${tail}\n`;
      const root = parser.parse(source).rootNode;
      assert.equal(root.namedChildCount, 302, prefix);
      const rule = root.firstNamedChild;
      assert.equal(rule.childForFieldName("selectors").text, ".a", prefix);
      assert.deepEqual(
        rule.descendantsOfType("property_declaration").map(node => node.text),
        ["color: red;", "width: 1px;"],
        prefix
      );
      assert.deepEqual(
        rule.descendantsOfType("ERROR").map(node => node.text),
        [prefix],
        prefix
      );
    }
    // Longer headers, and a compound ending in a separator above a declaration, end at their line too.
    for (const prefix of ["a b", ".b .c", ".b > .c", ".b,", ".b >", "&:is("]) {
      const source = `.a {\n  color: red;\n  ${prefix}\n  width: 1px;\n}\n.y {\n  color: blue;\n}\n${tail}\n`;
      const root = parser.parse(source).rootNode;
      assert.equal(root.namedChildCount, 302, prefix);
      const rule = root.firstNamedChild;
      assert.deepEqual(
        rule.descendantsOfType("property_declaration").map(node => node.text),
        ["color: red;", "width: 1px;"],
        prefix
      );
      const errors = rule.descendantsOfType("ERROR");
      assert.deepEqual(
        errors.map(node => node.text),
        [prefix],
        prefix
      );
      assert.ok(errors[0].descendantsOfType(["class_selector", "tag_selector", "parent_selector"]).length, prefix);
    }
    // A stray separator line stays an error instead of disappearing into the statement break.
    for (const separator of [",", "("]) {
      const rule = parser.parse(`.a {\n  color: red;\n  ${separator}\n  width: 1px;\n}\n`).rootNode.firstNamedChild;
      assert.deepEqual(
        rule.descendantsOfType("ERROR").map(node => node.text),
        [separator]
      );
    }
    // Sass rejects extending a complex selector; the line still ends without absorbing the next rule.
    const extend = parser.parse(`.a {\n  @extend .b\n    .c;\n}\n.after {}\n`).rootNode;
    assert.equal(extend.namedChildCount, 2);
    assert.equal(extend.lastNamedChild.text, ".after {}");
    // A selector still continues on later lines when its block follows, even past the lookahead window.
    for (const selector of [
      ".b\n.c",
      ".b\n  c\n  d",
      ":is(.b\n  .c)",
      ".b // note\n  .c",
      `.b\n  ${".c, ".repeat(400)}.d`
    ]) {
      const root = parser.parse(`.a {\n  ${selector} { color: red; }\n}`).rootNode;
      assert.equal(root.hasError, false, selector);
      assert.equal(root.descendantsOfType("complex_selector").length, 1, selector);
    }
  }
});
