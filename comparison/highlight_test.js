const assert = require("node:assert/strict");
const { test } = require("node:test");

const light = { function: "#bf3989", keyword: "#cf222e", property: "#0969da", string: "#0a3069", variable: "#d4631a" };
const dark = { function: "#f76dba", keyword: "#fe7872", property: "#6faaff", string: "#a2c6fe", variable: "#ed7937" };
const theme = { light, dark };
const capture = (id, name, startIndex, endIndex) => ({ name, node: { id, startIndex, endIndex } });

test("highlights preserve nested roles, later overrides, and CLI theme matching", async () => {
  const { highlight } = await import("./highlight.mjs");
  const result = highlight(
    '"a $x z"',
    [capture(1, "string", 0, 8), capture(2, "property", 3, 5), capture(2, "variable.parameter", 3, 5)],
    theme
  );
  assert.deepEqual(
    result.segments.map(({ start, end, key }) => [start, end, key]),
    [
      [0, 3, "string"],
      [3, 5, "variable"],
      [5, 8, "string"]
    ]
  );
  assert.match(result.html, /--hl-light: #d4631a; --hl-dark: #ed7937" title="@variable.parameter">\$x<\/span>/);
  assert.equal(highlight("@function", [capture(1, "keyword.function", 0, 9)], theme).segments[0].key, "function");
  assert.equal(highlight("abc", [capture(1, "string", 0, 3), capture(1, "spell", 0, 3)], theme).segments[0].key, null);
});

test("Unicode indices and HTML-like source remain literal text", async () => {
  const { highlight } = await import("./highlight.mjs");
  const source = '"中文 🦊 </textarea><script>x</script>"';
  const result = highlight(source, [capture(1, "string", 0, source.length)], theme);
  assert.match(result.html, /中文 🦊 &lt;\/textarea&gt;&lt;script&gt;/);
  assert.doesNotMatch(result.html, /<script>/);
  assert.equal(result.segments.at(-1).end, source.length);
});

test("difference markers compare displayed colors and ignore whitespace", async () => {
  const { highlight, differentLines } = await import("./highlight.mjs");
  const source = "$x\n  \ny";
  const first = highlight(source, [capture(1, "variable", 0, 2), capture(2, "string", 3, 5)], theme);
  const sameColor = highlight(source, [capture(1, "variable.parameter", 0, 2)], theme);
  assert.deepEqual(differentLines(source, [first, sameColor]), []);
  const other = highlight(source, [capture(1, "property", 0, 2)], theme);
  assert.deepEqual(differentLines(source, [first, other]), [1]);
});

test("both palettes give every theme key its own color", () => {
  const { loadThemes } = require("./build.js");
  const { light, dark } = loadThemes();
  assert.deepEqual(Object.keys(dark), Object.keys(light));
  for (const palette of [light, dark]) assert.equal(new Set(Object.values(palette)).size, Object.keys(palette).length);
});

test("diagnostic markers respect exclusive ends and retain missing nodes at EOF", async () => {
  const { diagnosticLabel, diagnosticsByLine } = await import("./highlight.mjs");
  const error = { kind: "ERROR", type: "ERROR", from: { row: 0, column: 2 }, to: { row: 2, column: 0 } };
  const missing = { kind: "MISSING", type: "}", from: { row: 2, column: 0 }, to: { row: 2, column: 0 } };
  assert.equal(diagnosticLabel(error), "ERROR L1:3–L3:1");
  assert.equal(diagnosticLabel(missing), 'MISSING "}" at L3:1');
  const lines = diagnosticsByLine([error, missing]);
  assert.deepEqual([...lines.keys()], [1, 2, 3]);
  assert.deepEqual(lines.get(3), ['MISSING "}" at L3:1']);
  const overlap = diagnosticsByLine([error, { ...missing, from: { row: 1, column: 5 }, to: { row: 1, column: 5 } }]);
  assert.equal(overlap.get(2).length, 2);
});

test("diagnostic content preserves exact source and marks zero-width missing nodes in context", async () => {
  const { diagnosticContent } = await import("./highlight.mjs");
  const source = '🦊\n.bad {\n  content: "</code><script>x</script>";\n';
  const start = source.indexOf(".bad");
  assert.deepEqual(diagnosticContent(source, { kind: "ERROR", start, end: source.length }), {
    before: source.slice(start),
    marker: "",
    after: ""
  });
  assert.deepEqual(diagnosticContent(source, { kind: "MISSING", type: "}", start: source.length }), {
    before: '  content: "</code><script>x</script>";\n',
    marker: '⟨missing "}"⟩',
    after: ""
  });
  const text = "\t.卡片🦊 { color red; }";
  const at = text.indexOf(" red");
  assert.deepEqual(diagnosticContent(text, { kind: "MISSING", type: ":", start: at }), {
    before: "\t.卡片🦊 { color",
    marker: '⟨missing ":"⟩',
    after: " red; }"
  });
  assert.deepEqual(diagnosticContent("", { kind: "MISSING", type: ";", start: 0 }), {
    before: "",
    marker: '⟨missing ";"⟩',
    after: ""
  });
});
