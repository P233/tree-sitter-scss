const assert = require("node:assert/strict");
const { test } = require("node:test");
const Parser = require("tree-sitter");
const Scss = require("./index.js");
const { recoveryFixtures, typingStates } = require("../../scripts/recovery-fixtures.js");
const { regionReference, assertRegion } = require("../../scripts/recovery-assertions.js");

const selections = require("../../scripts/recovery-contract.json");
const expectations = require("../../scripts/recovery-acceptance.json");
const fixtures = [...recoveryFixtures()];
const fixtureId = fixture => `${fixture.family}/${fixture.mode}/${fixture.key}`;

function validateSelections(cases, selected, counters) {
  assert.deepEqual(Object.keys(selected).sort(), cases.map(fixtureId).sort(), "reviewed fixture IDs");
  for (const fixture of cases) {
    const id = fixtureId(fixture);
    const rows = counters.suites[fixture.family]?.[fixture.mode];
    const layout = fixture.key.slice(0, -fixture.statement.length - 1);
    const row = ["contract", "typing"].includes(fixture.family)
      ? rows?.[layout]?.[fixture.statement]
      : rows?.[fixture.key];
    assert.ok(row, `${id}: no exact counter row`);
    const key = selected[id];
    if (key === null) continue;
    const count = fixture.family === "typos" ? 1 : (row.keys ?? row.states);
    assert.ok(Number.isInteger(key) && key > 0 && key <= count, `${id}: key ${key} outside ${count} counter keys`);
  }
}

test("reviewed recovery selections resolve every fixture and counter key", () => {
  validateSelections(fixtures, selections, expectations);
  const fixture = fixtures[0];
  const id = fixtureId(fixture);
  const selected = { [id]: selections[id] };
  assert.throws(() => validateSelections([fixture], { ...selected, stale: 1 }, expectations), /reviewed fixture IDs/);
  assert.throws(() => validateSelections([fixture], selected, { suites: {} }), /no exact counter row/);
  const counters = globalThis.structuredClone(expectations);
  const layout = fixture.key.slice(0, -fixture.statement.length - 1);
  counters.suites[fixture.family][fixture.mode][layout][fixture.statement].keys = selected[id] - 1;
  assert.throws(() => validateSelections([fixture], selected, counters), /outside .* counter keys/);
});

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

for (const fixture of fixtures) {
  const dialect = fixture.dialect ?? "scss";
  const id = fixtureId(fixture);
  assert.ok(Object.hasOwn(selections, id), `Missing reviewed recovery state: ${id}`);
  const state = selectedState(fixture, selections[id]);
  if (!state) continue;
  const context = `${id} key-${state.key}`;
  test(`conditional isolation ${context}`, () => {
    const language = dialect === "css" ? Scss.cssLanguage : Scss;
    const { parser, query, references } = hosts.get(language);
    const original = fixture.complete ?? fixture.before + fixture.after;
    const referenceKey = JSON.stringify([original, fixture.regions]);
    if (!references.has(referenceKey)) {
      const complete = parser.parse(original);
      assert.equal(complete.rootNode.hasError, false, `${context}: complete reference`);
      references.set(
        referenceKey,
        fixture.regions.map(region => regionReference(query, complete, region))
      );
    }
    const regions = references.get(referenceKey);
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
