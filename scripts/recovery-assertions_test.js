const assert = require("node:assert/strict");
const { test } = require("node:test");
const Parser = require("tree-sitter");
const Scss = require("../bindings/node");
const { statementUnits, intactUnit, regionReference, assertRegion } = require("./recovery-assertions.js");
const { recoveryFamilies, recoveryFixtures } = require("./recovery-fixtures.js");

test("protected statements retain their ancestor path even when the new container is error-free", () => {
  for (const language of [Scss, Scss.cssLanguage]) {
    const parser = new Parser().setLanguage(language);
    const query = new Parser.Query(language, Scss.HIGHLIGHTS_QUERY);
    const source = ".outer {}\n.tail {}";
    const complete = parser.parse(source);
    const current = parser.parse(".outer { \n.tail {}}");
    assert.equal(complete.rootNode.hasError, false);
    assert.equal(current.rootNode.hasError, false);
    const unit = statementUnits(complete.rootNode).find(unit => unit.start === source.indexOf(".tail"));
    const moved = current.rootNode.descendantsOfType("rule_set").find(node => node.text === ".tail {}");
    assert.equal(moved.startIndex, unit.start);
    assert.equal(moved.toString(), unit.sexp);
    assert.equal(intactUnit(current.rootNode, unit.start, unit.end, unit), false);
    const region = regionReference(query, complete, { name: "tail", start: unit.start, end: unit.end });
    assert.throws(() => assertRegion(query, region, current, 0, "moved rule"), /ancestor path/);
  }
});

test("declared recovery region boundaries reject a missing head or tail", () => {
  const family = recoveryFamilies.typing;
  const layouts = family.layouts;
  try {
    family.layouts = () =>
      Object.fromEntries(Object.entries(layouts()).map(([name, [before, after]]) => [name, [before.slice(1), after]]));
    assert.throws(() => [...recoveryFixtures()], /missing its head boundary/);
    family.layouts = () =>
      Object.fromEntries(
        Object.entries(layouts()).map(([name, [before, after]]) => [name, [before, after.slice(0, -1)]])
      );
    assert.throws(() => [...recoveryFixtures()], /missing its tail boundary/);
  } finally {
    family.layouts = layouts;
  }
});
