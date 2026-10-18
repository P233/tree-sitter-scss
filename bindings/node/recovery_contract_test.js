const assert = require("node:assert/strict");
const { test } = require("node:test");
const Parser = require("tree-sitter");
const Scss = require("./index.js");
const { recoveryFixtures, typingStates } = require("../../scripts/recovery-fixtures.js");
const { regionReference, assertRegion } = require("../../scripts/recovery-assertions.js");

const selections = require("../../scripts/recovery-contract.json");

function selectedState(fixture, key) {
  if (key === null) return null;
  if (fixture.family === "typos") return { text: fixture.text, key };
  const states = [
    ...typingStates(fixture.before, fixture.after, fixture.statement, fixture.pairs, fixture.includeOvertypes)
  ];
  assert.ok(
    Number.isInteger(key) && key > 0 && key <= states.length,
    `${fixture.family}/${fixture.key}: invalid selected key ${key}`
  );
  return { ...states[key - 1], key, states: states.slice(0, key) };
}

const hosts = new Map(
  [Scss, Scss.cssLanguage].map(language => [
    language,
    {
      parser: new Parser().setLanguage(language),
      query: new Parser.Query(language, Scss.HIGHLIGHTS_QUERY),
      references: new Map()
    }
  ])
);

for (const fixture of recoveryFixtures()) {
  const dialect = fixture.dialect ?? "scss";
  const id = `${fixture.family}/${fixture.mode}/${fixture.key}`;
  assert.ok(Object.hasOwn(selections, id), `Missing reviewed recovery state: ${id}`);
  const state = selectedState(fixture, selections[id]);
  if (!state) continue;
  const context = `${id} key-${state.key}`;
  test(`conditional isolation ${context}`, () => {
    const language = dialect === "css" ? Scss.cssLanguage : Scss;
    const { parser, query, references } = hosts.get(language);
    const original = fixture.complete ?? fixture.before + fixture.after;
    if (!references.has(original)) {
      const complete = parser.parse(original);
      assert.equal(complete.rootNode.hasError, false, `${context}: complete reference`);
      references.set(
        original,
        fixture.regions.map(region => regionReference(query, complete, region))
      );
    }
    const regions = references.get(original);
    let current;
    if (fixture.family === "typing" || fixture.family === "blockend") {
      current = parser.parse(fixture.before + fixture.after);
      for (const { text, edit } of state.states) {
        current.edit(edit);
        current = parser.parse(text, current);
      }
    } else current = parser.parse(state.text);
    for (const region of regions) {
      assertRegion(
        query,
        region,
        current,
        region.name === "before-block" ? 0 : state.text.length - original.length,
        context
      );
    }
    if (fixture.family === "blockend") {
      const fresh = parser.parse(state.text);
      for (const region of regions) {
        assertRegion(
          query,
          region,
          fresh,
          region.name === "before-block" ? 0 : state.text.length - original.length,
          `${context} fresh`
        );
      }
    }
  });
}
