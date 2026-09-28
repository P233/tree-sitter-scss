const assert = require("node:assert/strict");
const { test } = require("node:test");
const Parser = require("tree-sitter");
const Scss = require("./index.js");

function parse(source, language, parser = new Parser(), previous) {
  parser.setLanguage(language);
  const tree = parser.parse(source, previous);
  assert.equal(tree.rootNode.hasError, false, `${source}\n${tree.rootNode.toString()}`);
  return tree;
}

function texts(tree, type) {
  return tree.rootNode.descendantsOfType(type).map(node => node.text);
}

function priorities(tree) {
  return tree.rootNode
    .descendantsOfType("property_declaration")
    .flatMap(node => node.namedChildren.filter(child => child.type === "important" || child.type === "flag"));
}

for (const language of [Scss, Scss.cssLanguage]) {
  const query = new Parser.Query(language, language.HIGHLIGHTS_QUERY);

  test(`${language.name}: declaration priority accepts CSS whitespace and comments`, () => {
    for (const priority of [
      "!important",
      "! ImPoRtAnT",
      "!\nimportant",
      "!\r\nimportant",
      "!\fimportant",
      "!/**/important",
      "! /*before*/ important"
    ]) {
      const source = `.a { color: red ${priority}; --ink: blue ${priority}; } .next { display: grid; }`;
      const tree = parse(source, language);
      const nodes = priorities(tree);
      assert.deepEqual(
        nodes.map(node => node.text),
        [priority, priority],
        source
      );
      for (const node of nodes) {
        assert.ok(
          query
            .captures(tree.rootNode)
            .some(capture => capture.name === "keyword.modifier" && capture.node.id === node.id),
          `Priority must have a keyword.modifier capture: ${priority}`
        );
      }
      assert.deepEqual(texts(tree, "property_name"), ["color", "--ink", "display"]);
      assert.equal(texts(tree, "block_comment").length, priority.includes("/*") ? 2 : 0);
    }
  });

  test(`${language.name}: priority is separate from raw payload at declaration endings`, () => {
    const source = ".a { --ink: blue !important /*after*/; --empty: !important; color: red !important }";
    const tree = parse(source, language);
    assert.deepEqual(
      priorities(tree).map(node => node.text),
      ["!important", "!important", "!important"]
    );
    assert.deepEqual(texts(tree, "raw_value"), ["blue"]);
    assert.deepEqual(texts(tree, "block_comment"), ["/*after*/"]);
  });

  test(`${language.name}: compact priority separates from every raw token prefix`, () => {
    const source =
      ".a { --ink:blue!important; --path:https://example.test/!important; --hash:#abc!important; color:red!important; }";
    const tree = parse(source, language);
    assert.deepEqual(
      priorities(tree).map(node => node.text),
      ["!important", "!important", "!important", "!important"]
    );
    assert.deepEqual(texts(tree, "raw_value"), ["blue", "https://example.test/", "#abc"]);
  });

  test(`${language.name}: strings and nested raw groups do not contain declaration priority`, () => {
    const source =
      '.a { content: "!important"; --tokens: "!important" (!important) [!important] { !important }; color: red; }';
    const tree = parse(source, language);
    assert.deepEqual(priorities(tree), []);
    assert.deepEqual(texts(tree, "important"), []);
    assert.deepEqual(texts(tree, "string"), ['"!important"', '"!important"']);
    assert.deepEqual(texts(tree, "property_name"), ["content", "--tokens", "color"]);
  });

  test(`${language.name}: raw priority-like tokens retain complete boundaries`, () => {
    for (const value of [
      "!importantish",
      "!important-ish",
      "!important extra",
      String.raw`!important\78`,
      String.raw`foo\!important`,
      "foo!importantish"
    ]) {
      // These raw payloads are retained for editing; this is not CSS value validation.
      const tree = parse(`.a { --tokens: ${value}; color: red; }`, language);
      assert.deepEqual(priorities(tree), [], value);
      assert.deepEqual(texts(tree, "raw_value"), [value]);
      assert.deepEqual(texts(tree, "property_name"), ["--tokens", "color"]);
    }
  });

  test(`${language.name}: quoted keyframe names keep string and escape nodes`, () => {
    const source = String.raw`@keyframes "fade" { from { opacity: 0; } to { opacity: 1; } } @-webkit-keyframes 'none' { 50% {} } @KEYFRAMES "fa\64 e" { entry 0% {} } .next { color: red; }`;
    const tree = parse(source, language);
    assert.equal(texts(tree, "keyframes_statement").length, 3);
    assert.deepEqual(texts(tree, "string"), ['"fade"', "'none'", String.raw`"fa\64 e"`]);
    assert.deepEqual(texts(tree, "escape_sequence"), [String.raw`\64 `]);
    assert.deepEqual(texts(tree, "property_name"), ["opacity", "opacity", "color"]);
    const captures = query.captures(tree.rootNode);
    for (const node of tree.rootNode.descendantsOfType("string")) {
      assert.ok(captures.some(capture => capture.name === "string" && capture.node.id === node.id));
    }
  });

  test(`${language.name}: priority and quoted-name incremental edits agree with fresh parses`, () => {
    for (const [before, after] of [
      [".a { --x: red !important; color: blue; }", ".a { --x: red !importantish; color: blue; }"],
      [".a { --x: red (!important); color: blue; }", ".a { --x: red !important; color: blue; }"],
      ['@keyframes "fade" { from {} } .next {}', '@keyframes "fade-out" { from {} } .next {}']
    ]) {
      const parser = new Parser();
      const tree = parse(before, language, parser);
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
      const incremental = parse(after, language, parser, tree);
      const fresh = parse(after, language);
      assert.equal(incremental.rootNode.toString(), fresh.rootNode.toString());
      const captures = result =>
        query.captures(result.rootNode).map(({ name, node }) => [name, node.startIndex, node.endIndex]);
      assert.deepEqual(captures(incremental), captures(fresh));
    }
  });
}

test("SCSS flags and important values remain distinct from declaration suffixes", () => {
  const source =
    "$x: 1 !default !global; $priority: !important; .a { value: inspect(!important); @extend .base !optional; }";
  const tree = parse(source, Scss);
  assert.deepEqual(texts(tree, "flag"), ["!default", "!global", "!optional"]);
  assert.deepEqual(texts(tree, "important"), ["!important", "!important"]);
  assert.deepEqual(priorities(tree), []);
});

test("keyframe strings use each parser's interpolation dialect", () => {
  const source = '@keyframes "fade-#{$state}" { from { opacity: 0; } } .next { color: red; }';
  const scss = parse(source, Scss);
  const css = parse(source, Scss.cssLanguage);
  assert.deepEqual(texts(scss, "interpolation"), ["#{$state}"]);
  assert.deepEqual(texts(css, "interpolation"), []);
  assert.deepEqual(texts(scss, "property_name"), ["opacity", "color"]);
  assert.deepEqual(texts(css, "property_name"), ["opacity", "color"]);
});
