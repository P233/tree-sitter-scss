const { execFile } = require("node:child_process");
const { readFileSync, writeFileSync } = require("node:fs");
const { join, resolve } = require("node:path");
const { setImmediate: yieldToEventLoop } = require("node:timers/promises");
const { parseArgs, promisify } = require("node:util");
const Parser = require("tree-sitter");
const Scss = require("../bindings/node");
const { typingStates, recoveryFamilies } = require("./recovery-fixtures.js");

const { statementUnits, intactUnit, highlightRoles } = require("./recovery-assertions.js");

const EXPECTATIONS = join(__dirname, "recovery-acceptance.json");
const SUITES = ["contract", "typing", "blockend", "headers", "unfinished", "typos"];
function parserFor(language = Scss) {
  const parser = new Parser();
  parser.setLanguage(language);
  return parser;
}

// Tree finalizers run on the event loop, so a suite that never yields keeps every tree it parsed until it exits.
async function* releasingTrees(states) {
  for (const state of states) {
    yield state;
    await yieldToEventLoop();
  }
}

function tailIntact(tree, family) {
  const name = new RegExp(`^\\.${family.tail.name}\\d`);
  return tree.rootNode.namedChildren.filter(
    child => child.type === "rule_set" && !child.hasError && name.test(child.text)
  ).length;
}

async function contract(isPlain) {
  const parser = parserFor();
  const family = recoveryFamilies.contract;
  const pairs = isPlain ? {} : family.pairs;
  const results = {};
  for (const [category, statements] of Object.entries(family.statements)) {
    for (const [layout, [before, after]] of family.layouts(category)) {
      const base = parser.parse(before + after).rootNode;
      // Ancestor-path equality rules out `ERROR` ancestors only when this reference has none.
      if (base.hasError) throw new Error(`${category}/${layout}: contract reference has an error`);
      const units = statementUnits(base);
      const offset = before.length;
      const tailStart = before.length + after.length - family.tail.text.length;
      const enclosing = units
        .filter(unit => unit.start < offset && unit.end > offset)
        .sort((a, b) => a.end - a.start - (b.end - b.start))[0];
      const rows = (results[`${category}/${layout}`] = {});
      for (const statement of statements) {
        const row = (rows[statement] = {
          keys: 0,
          line: 0,
          block: 0,
          tail: 0,
          lineValid: 0,
          blockValid: 0,
          states: ""
        });
        for await (const { text } of releasingTrees(
          typingStates(before, after, statement, pairs, family.includeOvertypes)
        )) {
          const root = parser.parse(text).rootNode;
          const shift = text.length - before.length - after.length;
          let isLineBroken = false;
          let isBlockBroken = false;
          let isTailBroken = false;
          for (const unit of units) {
            if (unit.start < offset && unit.end > offset) continue;
            const start = unit.start >= offset ? unit.start + shift : unit.start;
            const end = unit.end > offset ? unit.end + shift : unit.end;
            if (intactUnit(root, start, end, unit)) continue;
            isLineBroken = true;
            if (!(enclosing && unit.start >= enclosing.start && unit.end <= enclosing.end)) isBlockBroken = true;
            if (unit.start >= tailStart) isTailBroken = true;
          }
          row.keys++;
          if (!isLineBroken) row.line++;
          if (!isBlockBroken) row.block++;
          if (isTailBroken) row.tail++;
          if (isLineBroken && !root.hasError) row.lineValid++;
          if (isBlockBroken && !root.hasError) row.blockValid++;
          row.states += (
            Number(isLineBroken) |
            (Number(isBlockBroken) << 1) |
            (Number(isTailBroken) << 2) |
            (Number(root.hasError) << 3)
          ).toString(16);
        }
      }
    }
  }
  return results;
}

async function typing(isPlain) {
  const parser = parserFor();
  const query = new Parser.Query(Scss, Scss.HIGHLIGHTS_QUERY);
  const family = recoveryFamilies.typing;
  const pairs = isPlain ? {} : family.pairs;
  const layouts = family.layouts();
  const results = {};
  for (const [layout, [before, after]] of Object.entries(layouts)) {
    const rows = (results[layout] = {});
    const probes = [Math.floor(family.tail.count / 2), family.tail.count - 1].map(index => {
      const name = `.${family.tail.name}${index}`;
      const offset = after.indexOf(`${name} {`);
      if (offset < 0) throw new Error(`${layout}: missing recovery tail probe ${name}`);
      return { name, offset };
    });
    for (const statement of family.statements) {
      let tree = parser.parse(before + after);
      const skip = Math.max(0, after.indexOf("\n"));
      const baseline = highlightRoles(query, tree, before.length + skip);
      const row = (rows[statement] = {
        keys: 0,
        changedKB: 0,
        quarterKeys: 0,
        lostTailKeys: 0,
        errorKeys: 0,
        finalError: false,
        nearKeys: 0,
        states: "",
        changedBytes: []
      });
      for await (const { text, edit } of releasingTrees(
        typingStates(before, after, statement, pairs, family.includeOvertypes)
      )) {
        tree.edit(edit);
        const next = parser.parse(text, tree);
        const changed = tree
          .getChangedRanges(next)
          .reduce((size, range) => size + range.endIndex - range.startIndex, 0);
        const isQuarterChanged = changed > text.length / 4;
        // Looking up only the probed rules avoids materializing every root child on each key.
        const isTailLost = !probes.every(({ name, offset }) => {
          const node = next.rootNode.firstNamedChildForIndex(text.length - after.length + offset);
          return node?.type === "rule_set" && node.childForFieldName("selectors")?.text === name;
        });
        const isNearChanged = highlightRoles(query, next, text.length - after.length + skip) !== baseline;
        row.keys++;
        row.changedKB += changed / 1024;
        row.changedBytes.push(changed);
        if (isQuarterChanged) row.quarterKeys++;
        if (isTailLost) row.lostTailKeys++;
        if (next.rootNode.hasError) row.errorKeys++;
        if (isNearChanged) row.nearKeys++;
        row.states += (
          Number(isQuarterChanged) |
          (Number(isTailLost) << 1) |
          (Number(next.rootNode.hasError) << 2) |
          (Number(isNearChanged) << 3)
        ).toString(16);
        tree = next;
      }
      row.changedKB = Math.round(row.changedKB);
      row.finalError = tree.rootNode.hasError;
    }
  }
  return results;
}

async function blockend(isPlain) {
  const family = recoveryFamilies.blockend;
  const pairs = isPlain ? {} : family.pairs;
  const layouts = family.layouts();
  const results = {};
  for (const [dialect, language] of [
    ["scss", Scss],
    ["css", Scss.cssLanguage]
  ]) {
    const parser = parserFor(language);
    for (const [layout, [before, after]] of Object.entries(layouts)) {
      for (const statement of family.statements) {
        let tree = parser.parse(before + after);
        const row = (results[`${dialect}/${layout}/${statement}`] = {
          states: 0,
          incBroken: 0,
          freshBroken: 0,
          rootError: 0,
          worstInc: family.tail.count,
          finalInc: 0,
          finalFresh: 0,
          incTail: [],
          freshTail: [],
          rootErrors: ""
        });
        for await (const { text, edit } of releasingTrees(
          typingStates(before, after, statement, pairs, family.includeOvertypes)
        )) {
          tree.edit(edit);
          tree = parser.parse(text, tree);
          const inc = tailIntact(tree, family);
          const fresh = tailIntact(parser.parse(text), family);
          const isRootError = tree.rootNode.type === "ERROR";
          row.states++;
          if (inc < family.tail.count) row.incBroken++;
          if (fresh < family.tail.count) row.freshBroken++;
          if (isRootError) row.rootError++;
          row.worstInc = Math.min(row.worstInc, inc);
          row.finalInc = inc;
          row.finalFresh = fresh;
          row.incTail.push(inc);
          row.freshTail.push(fresh);
          row.rootErrors += Number(isRootError);
        }
      }
    }
  }
  return results;
}

async function cleanHeaders() {
  const parser = parserFor();
  const family = recoveryFamilies.headers;
  const layouts = family.layouts();
  const results = {};
  for (const [layout, [before, after]] of Object.entries(layouts)) {
    for (const header of family.statements) {
      const row = (results[`${layout}/${header}`] = { keys: 0, broken: 0, tail: [] });
      for await (const { text } of releasingTrees(
        typingStates(before, after, header, family.pairs, family.includeOvertypes)
      )) {
        const intact = tailIntact(parser.parse(text), family);
        row.keys++;
        if (intact < family.tail.count) row.broken++;
        row.tail.push(intact);
      }
    }
  }
  return results;
}

async function headersAfterUnfinished() {
  const parser = parserFor();
  const family = recoveryFamilies.unfinished;
  const layouts = family.layouts();
  const results = {};
  for (const [layout, [before, after]] of Object.entries(layouts)) {
    for (const line of Object.values(family.lines).flat()) {
      for (const header of family.statements) {
        const row = (results[`${layout}/${line}/${header}`] = { keys: 0, broken: 0, tail: [] });
        for await (const { text } of releasingTrees(
          typingStates(before(line), after, header, family.pairs, family.includeOvertypes)
        )) {
          const tree = parser.parse(text);
          // An ERROR root can still hold intact rules, but the whole file is then one error.
          const intact = tree.rootNode.type === "ERROR" ? 0 : tailIntact(tree, family);
          row.keys++;
          if (intact < family.tail.count) row.broken++;
          row.tail.push(intact);
        }
      }
    }
  }
  return results;
}

function typoProbes() {
  const family = recoveryFamilies.typos;
  const results = {};
  for (const [dialect, language] of [
    ["scss", Scss],
    ["css", Scss.cssLanguage]
  ]) {
    const parser = parserFor(language);
    for (const [name, head] of Object.entries(family.statements)) {
      const root = parser.parse(family.source(head)).rootNode;
      results[`${dialect}/${name}`] = { children: root.namedChildCount, hasError: root.hasError };
    }
  }
  return results;
}

function compare(expected, actual, path) {
  if (typeof expected !== "object" || expected === null) {
    if (expected === actual) return;
    if (typeof expected === "string" && (path.endsWith("/states") || path.endsWith("/rootErrors"))) {
      let index = 0;
      while (index < expected.length && expected[index] === actual?.[index]) index++;
      throw new Error(
        `${path}/key-${index + 1}: expected ${expected[index] ?? "end"}, got ${actual?.[index] ?? "end"}.`
      );
    }
    throw new Error(`${path}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}.`);
  }
  if (
    !actual ||
    typeof actual !== "object" ||
    JSON.stringify(Object.keys(expected)) !== JSON.stringify(Object.keys(actual))
  ) {
    throw new Error(`${path}: counter names differ.`);
  }
  for (const key of Object.keys(expected)) compare(expected[key], actual[key], `${path}/${key}`);
}

async function runWorker(suite, isPlain) {
  if (!SUITES.includes(suite)) throw new Error(`Unknown recovery suite: ${suite}.`);
  const measure = {
    contract,
    typing,
    blockend,
    headers: cleanHeaders,
    unfinished: headersAfterUnfinished,
    typos: typoProbes
  }[suite];
  const result = await measure(isPlain);
  // Exit once the pipe takes the counters; a synchronous write to it fails past its buffer, and native node finalizers
  // need not drain.
  process.stdout.write(JSON.stringify(result) + "\n", () => process.exit(0));
}

async function main(values) {
  const expected = values.record ? null : JSON.parse(readFileSync(EXPECTATIONS, "utf8"));
  const actual = {
    version: 1,
    flags: {
      contract: "line-broken=1 block-broken=2 tail-lost=4 has-error=8",
      typing: "quarter-changed=1 tail-lost=2 has-error=4 near-changed=8"
    },
    suites: {}
  };
  const jobs = SUITES.flatMap(suite =>
    (["contract", "typing", "blockend"].includes(suite) ? ["paired", "plain"] : ["paired"]).map(mode => ({
      suite,
      mode
    }))
  );
  // The workers share nothing, so they run concurrently; the timeout only bounds a hang on a loaded machine.
  const outputs = await Promise.all(
    jobs.map(({ suite, mode }) =>
      promisify(execFile)(
        process.execPath,
        [join(__dirname, "recovery-acceptance.js"), "--worker", suite, ...(mode === "plain" ? ["--plain"] : [])],
        { encoding: "utf8", timeout: 600_000, maxBuffer: 16 * 1024 * 1024 }
      )
    )
  );
  jobs.forEach(({ suite, mode }, index) => {
    const result = JSON.parse(outputs[index].stdout);
    (actual.suites[suite] ??= {})[mode] = result;
    if (expected) compare(expected.suites[suite]?.[mode], result, `${suite}/${mode}`);
    console.log(`Recovery acceptance: ${suite}/${mode} ${expected ? "matches exact counters" : "recorded"}.`);
  });
  if (expected) compare(expected, actual, "recovery");
  if (values.record) {
    const file = resolve(values.record);
    writeFileSync(file, JSON.stringify(actual, null, 2) + "\n");
    console.log(`Recorded recovery counters in ${file}; review every change before replacing expectations.`);
  }
}

const { values } = parseArgs({
  options: { worker: { type: "string" }, plain: { type: "boolean" }, record: { type: "string" } }
});
if (values.worker) {
  runWorker(values.worker, values.plain).catch(error =>
    process.stderr.write(`${error.stack ?? error}\n`, () => process.exit(1))
  );
} else {
  main(values).catch(error => {
    console.error(error.stderr?.toString() || error.message);
    process.exitCode = 1;
  });
}
