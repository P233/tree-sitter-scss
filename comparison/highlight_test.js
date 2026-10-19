const assert = require("node:assert/strict");
const { test } = require("node:test");

const light = { function: "#bf3989", keyword: "#cf222e", property: "#0969da", string: "#0a3069", variable: "#d4631a" };
const dark = { function: "#f76dba", keyword: "#fe7872", property: "#6faaff", string: "#a2c6fe", variable: "#ed7937" };
const theme = { light, dark };
const capture = (id, name, startIndex, endIndex) => ({ name, node: { id, startIndex, endIndex } });

test("highlights preserve nested roles, later overrides, and shared role matching", async () => {
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
  assert.equal(highlight("@function", [capture(1, "keyword.function", 0, 9)], theme).segments[0].key, "keyword");
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

test("difference markers compare any number of engines", async () => {
  const { highlight, differentLines } = await import("./highlight.mjs");
  const source = "a\nb\nc";
  const same = highlight(source, [capture(1, "variable", 0, 1)], theme);
  const third = highlight(source, [capture(1, "property", 0, 1), capture(2, "string", 4, 5)], theme);
  assert.deepEqual(differentLines(source, []), []);
  assert.deepEqual(differentLines(source, [same]), []);
  assert.deepEqual(differentLines(source, [same, same, same]), []);
  assert.deepEqual(differentLines(source, [same, same, third]), [1, 3]);
  assert.deepEqual(differentLines(source, [same, same, third, same]), [1, 3]);
  assert.deepEqual(differentLines(source, [third, same, same]), [1, 3]);
});

test("every engine maps identical capture names onto the same shared roles", async () => {
  const { highlight, differentLines } = await import("./highlight.mjs");
  const { loadThemes } = require("./build.js");
  const themes = loadThemes();
  const roles = {
    "selector.class": "attribute",
    "selector.id": "attribute",
    "selector.pseudo": "attribute",
    namespace: "module",
    boolean: "constant.builtin",
    "keyword.function": "keyword",
    "keyword.operator": "operator",
    embedded: "punctuation.special"
  };
  for (const [name, role] of Object.entries(roles)) {
    const results = Array.from({ length: 3 }, () => highlight("x", [capture(1, name, 0, 1)], themes));
    for (const result of results) {
      assert.equal(result.segments[0].key, role, name);
      assert.match(result.html, new RegExp(`title="@${name}"`));
    }
    const canonical = highlight("x", [capture(1, role, 0, 1)], themes);
    assert.deepEqual(differentLines("x", [...results, canonical]), []);
  }
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

function measureWithClock(parseWarm, { durations, quantized = false, failAt, nullAt }) {
  const actual = globalThis.performance;
  let clock = 0;
  let calls = 0;
  let live = 0;
  let deleted = 0;
  let peak = 0;
  const batches = [];
  let start;
  let duration;
  let parses = 0;
  globalThis.performance = {
    now() {
      const now = quantized ? Math.floor(clock * 10) / 10 : clock;
      if (start === undefined) start = now;
      else duration = now - start;
      return now;
    }
  };
  const parser = {
    parse() {
      calls++;
      if (calls === failAt) throw new Error("parse failure");
      if (calls === nullAt) return null;
      clock += calls === 1 ? 1000 : durations[(calls - 2) % durations.length];
      if (calls > 1) parses++;
      live++;
      peak = Math.max(peak, live);
      let isDeleted = false;
      return {
        delete() {
          assert.equal(isDeleted, false, "tree deleted twice");
          isDeleted = true;
          live--;
          deleted++;
          if (start !== undefined) {
            batches.push({ duration, parses });
            start = undefined;
            parses = 0;
          }
          clock += 100;
        }
      };
    }
  };
  try {
    if (failAt || nullAt) {
      assert.throws(() => parseWarm(parser, "x"), /parse failure|Parser did not return a tree/);
      assert.equal(live, 0);
      assert.equal(deleted, calls - 1);
      return;
    }
    const { tree, parseTime } = parseWarm(parser, "x");
    assert.equal(live, 1, "only the returned tree remains owned by the caller");
    assert.equal(calls, parseTime.parses + 1, "warm-up is excluded");
    tree.delete();
    assert.equal(live, 0);
    assert.equal(deleted, calls);
    assert.equal(batches.length, parseTime.batches);
    assert.ok(batches.every(batch => batch.duration >= 10));
    const elapsed = batches.reduce((sum, batch) => sum + batch.duration, 0);
    assert.ok(elapsed >= 100);
    assert.ok(parseTime.batches >= 5);
    if (parseTime.batches > 5) assert.ok(elapsed - batches.at(-1).duration < 100);
    assert.ok(parseTime.medianMs > 0);
    return { ...parseTime, peak, batchesMeasured: batches };
  } finally {
    globalThis.performance = actual;
  }
}

test("warm parse timing uses bounded batches, the time budget and median of batch means", async t => {
  const { parseWarm } = await import("./parse.mjs");
  const cases = [
    { durations: [5], batches: 10, parses: 20, median: 5 },
    { durations: [10], batches: 10, parses: 10, median: 10 },
    { durations: [9.99], batches: 6, parses: 12, median: 9.99 },
    { durations: [25], batches: 5, parses: 5, median: 25 },
    { durations: [1000], batches: 5, parses: 5, median: 1000 },
    { durations: [25, 20], batches: 5, parses: 5, median: 25 },
    { durations: [10, 30, 10, 20, 10, 20], batches: 6, parses: 6, median: 15 },
    { durations: [2, 9, 10, 30, 2, 8, 20, 20], batches: 6, parses: 8, median: 15 },
    { durations: [0.04], batches: 10, parses: 2500, median: 0.04, quantized: true }
  ];
  for (const item of cases) {
    await t.test(JSON.stringify(item), () => {
      const result = measureWithClock(parseWarm, item);
      assert.equal(result.batches, item.batches);
      assert.equal(result.parses, item.parses);
      assert.ok(Math.abs(result.medianMs - item.median) < 1e-8);
      if (item.quantized) assert.ok(result.peak > 1);
      if (item.durations[0] >= 10) assert.ok(result.batchesMeasured.every(batch => batch.parses === 1));
    });
  }
});

test("warm parse timing cleans trees after thrown and null parses", async () => {
  const { parseWarm } = await import("./parse.mjs");
  for (const options of [
    { durations: [1], failAt: 1 },
    { durations: [1], failAt: 8 },
    { durations: [3], failAt: 15 },
    { durations: [1], nullAt: 1 },
    { durations: [1], nullAt: 8 }
  ])
    measureWithClock(parseWarm, options);
});

test("parse times use two significant figures without exponents and seconds from one second", async () => {
  const { formatParseTime } = await import("./parse.mjs");
  for (const [medianMs, text] of [
    [0.00001234, "0.000012 ms"],
    [0.0356, "0.036 ms"],
    [0.1, "0.10 ms"],
    [1, "1.0 ms"],
    [12.34, "12 ms"],
    [999, "1.0 s"],
    [1000, "1.0 s"],
    [12345, "12 s"],
    [1234567, "1200 s"]
  ])
    assert.equal(formatParseTime({ medianMs, batches: 5, parses: 10 }), `${text} (5 batches · 10 parses)`);
});
