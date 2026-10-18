const assert = require("node:assert/strict");
const { shape } = require("./fuzz.js");

function isStatement(parent, node) {
  return (parent.type === "stylesheet" || parent.type === "declaration_block") && node.type !== "ERROR";
}

function statementUnits(root) {
  const units = [];
  const walk = node => {
    for (const child of node.namedChildren) {
      if (isStatement(node, child)) {
        units.push({ start: child.startIndex, end: child.endIndex, type: child.type, sexp: child.toString() });
      }
      walk(child);
    }
  };
  walk(root);
  return units;
}

function regionStatements(root, region) {
  const statements = [];
  const walk = node => {
    for (const child of node.namedChildren) {
      if (child.endIndex <= region.start || child.startIndex >= region.end) continue;
      if (isStatement(node, child) && child.startIndex >= region.start && child.endIndex <= region.end) {
        statements.push(child);
      } else walk(child);
    }
  };
  walk(root);
  return statements;
}

function unitNode(root, start, end, type) {
  let node = root.descendantForIndex(start, Math.max(start, end - 1));
  while (node && !(node.startIndex === start && node.endIndex === end && node.type === type)) node = node.parent;
  return node;
}

function intactUnit(root, start, end, unit) {
  const node = unitNode(root, start, end, unit.type);
  if (!node || node.toString() !== unit.sexp) return false;
  for (let parent = node.parent; parent; parent = parent.parent) {
    if (parent.type === "ERROR") return false;
  }
  return true;
}

function highlightRoles(query, tree, start) {
  const end = start + 2000;
  const result = new Array(end - start).fill(null);
  for (const { name, node } of query.captures(tree.rootNode, { startIndex: start, endIndex: end })) {
    for (let i = Math.max(node.startIndex, start); i < Math.min(node.endIndex, end); i++) result[i - start] = name;
  }
  return result.join("|");
}

function firstDifference(expected, actual, label) {
  if (expected === actual) return;
  let index = 0;
  while (index < expected.length && expected[index] === actual[index]) index++;
  assert.fail(
    `${label} at ${index}: expected ${expected.slice(Math.max(0, index - 40), index + 100)}, got ${actual.slice(Math.max(0, index - 40), index + 100)}`
  );
}

function orderedCaptures(query, root, region, shift = 0) {
  const start = region.start + shift;
  const end = region.end + shift;
  return query
    .captures(root, { startIndex: start, endIndex: end })
    .filter(({ node }) => node.startIndex >= start && node.endIndex <= end)
    .map(({ name, node }) => `${name}@${node.startIndex - shift}-${node.endIndex - shift}`);
}

function regionReference(query, complete, region) {
  const units = regionStatements(complete.rootNode, region).map(node => ({
    start: node.startIndex,
    end: node.endIndex,
    type: node.type,
    shape: shape(node)
  }));
  assert.ok(units.length > 0, `${region.name}: no reference statements`);
  return { ...region, units, captures: orderedCaptures(query, complete.rootNode, region) };
}

function assertRegion(query, reference, current, shift, context) {
  const label = `${context} region=${reference.name}`;
  for (const unit of reference.units) {
    const node = unitNode(current.rootNode, unit.start + shift, unit.end + shift, unit.type);
    assert.ok(node, `${label}: missing ${unit.type}@${unit.start + shift}-${unit.end + shift}`);
    assert.equal(node.hasError, false, `${label}: ERROR/MISSING in ${unit.type}@${node.startIndex}`);
    for (let parent = node.parent; parent; parent = parent.parent) {
      assert.ok(parent.type !== "ERROR", `${label}: ${parent.type} ancestor of ${unit.type}@${node.startIndex}`);
    }
    firstDifference(unit.shape, shape(node, shift), `${label} node=${unit.type}@${node.startIndex}`);
  }
  const expected = reference.captures;
  const actual = orderedCaptures(query, current.rootNode, reference, shift);
  const index = expected.findIndex((capture, i) => capture !== actual[i]);
  const first = index < 0 ? expected.length : index;
  assert.ok(
    index < 0 && expected.length === actual.length,
    `${label} capture-${first}: expected ${expected[first]}, got ${actual[first]}`
  );
}

module.exports = { statementUnits, intactUnit, highlightRoles, regionReference, assertRegion };
