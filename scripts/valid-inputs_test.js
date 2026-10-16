const assert = require("node:assert/strict");
const { test } = require("node:test");
const { checkSass, validEdits, validInputs } = require("./valid-inputs.js");
const { recordCases } = require("./fuzz.js");

test("valid cases enumerate every original and edit only the intended statement", () => {
  const inputs = validInputs();
  assert.deepEqual(validInputs(), inputs);
  assert.equal(new Set(inputs.map(input => input.id)).size, inputs.length);
  assert.deepEqual(
    new Set(inputs.map(input => input.id.split("/")[1])),
    new Set(["selector", "header", "value", "raw", "budget", "comment"])
  );
  const edits = validEdits(inputs);
  for (const [input, source] of inputs.entries()) {
    const [original, opening, closing] = edits.slice(input * 3, input * 3 + 3);
    assert.deepEqual(original, { input, start: 0, del: 0, insert: "" });
    for (const edit of [opening, closing]) {
      assert.equal(edit.input, input);
      assert.ok(edit.start >= source.start && edit.start + edit.del <= source.end, source.id);
      const changed = source.text.slice(0, edit.start) + edit.insert + source.text.slice(edit.start + edit.del);
      assert.notEqual(changed, source.text, source.id);
      assert.ok(changed.endsWith(".after { width: 1px; }\n") || changed.endsWith(".after { width: 1px; }\r\n"));
    }
  }
});

test("a declared valid original fails even if both parsers would reject it identically", async () => {
  class RejectingParser {
    static Query = class {};
    setLanguage() {}
    parse() {
      return { rootNode: { hasError: true } };
    }
  }
  const inputs = [{ id: "valid/regression", text: "broken", start: 0, end: 6 }];
  await assert.rejects(
    Array.fromAsync(
      recordCases({
        Parser: RejectingParser,
        language: { name: "scss" },
        highlightsQuery: "",
        inputs,
        edits: validEdits(inputs),
        requiresValidInputs: true
      })
    ),
    /expected complete valid input: valid\/regression/
  );
});

test("optional Sass checking reports its implementation and never discards rejected inputs", () => {
  const inputs = [
    { id: "first", text: "a {}" },
    { id: "second", text: "b {}" }
  ];
  const seen = [];
  const sass = { info: "dart-sass\ttest", Logger: { silent: {} }, compileString: text => seen.push(text) };
  assert.deepEqual(checkSass(inputs, sass), { implementation: sass.info, inputs: 2 });
  assert.deepEqual(
    seen,
    inputs.map(input => input.text)
  );
  sass.compileString = () => {
    throw new Error("expected a block");
  };
  assert.throws(() => checkSass(inputs, sass), /Dart Sass rejected first: expected a block/);
});
