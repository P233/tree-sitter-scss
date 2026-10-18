const { readFileSync, writeFileSync } = require("node:fs");
const { join, resolve } = require("node:path");
const { parseArgs } = require("node:util");

const root = join(__dirname, "..");
const EXPECTATION = join(__dirname, "error-state.json");

function extractErrorState(source) {
  const section = name => {
    const match = source.match(new RegExp(`\\b${name}\\[[^;]*?=\\s*\\{([\\s\\S]*?)^\\};`, "m"));
    if (!match) throw new Error(`src/parser.c: ${name} is missing or has an unsupported format.`);
    return match[1];
  };
  const count = name => {
    const match = source.match(new RegExp(`^#define ${name} (\\d+)$`, "m"));
    if (!match) throw new Error(`src/parser.c: ${name} is missing.`);
    return Number(match[1]);
  };
  const names = new Map(
    [...section("ts_symbol_names").matchAll(/\[(\w+)\]\s*=\s*("(?:[^"\\]|\\.)*")/g)].map(([, name, display]) => [
      name,
      JSON.parse(display)
    ])
  );
  const external = new Set(
    [...section("ts_external_scanner_symbol_map").matchAll(/\[\w+\]\s*=\s*(\w+)/g)].map(match => match[1])
  );
  const state = section("ts_parse_table").match(/\[STATE\(0\)\]\s*=\s*\{([^}]+)\}/);
  if (!state) throw new Error("src/parser.c: parse state 0 is missing.");
  const tokens = [...state[1].matchAll(/\[(\w+)\]\s*=\s*ACTIONS\(([1-9]\d*)\)/g)]
    .map(([, name]) => {
      if (!names.has(name)) throw new Error(`src/parser.c: display name for ${name} is missing.`);
      return { name, display: names.get(name), isExternal: external.has(name) };
    })
    .sort((a, b) => a.name.localeCompare(b.name, "en"));
  if (!tokens.length) throw new Error("src/parser.c: parse state 0 has no tokens.");
  const modes = [...section("ts_lex_modes").matchAll(/\[(\d+)\]\s*=\s*\{\s*\.lex_state\s*=\s*(\d+)\b/g)];
  const states = count("STATE_COUNT");
  if (modes.length !== states) throw new Error(`src/parser.c: expected ${states} lex modes, got ${modes.length}.`);
  return {
    version: 1,
    states,
    largeStates: count("LARGE_STATE_COUNT"),
    lexState0: modes.filter(match => match[2] === "0").length,
    tokens
  };
}

function compareErrorState(expected, actual) {
  const messages = [];
  for (const [name, label] of [
    ["version", "version"],
    ["lexState0", "lex-state-0 sharing"]
  ]) {
    if (expected[name] !== actual[name]) messages.push(`${label}: ${expected[name]} -> ${actual[name]}`);
  }
  for (const [sign, left, right] of [
    ["-", expected.tokens, actual.tokens],
    ["+", actual.tokens, expected.tokens]
  ]) {
    for (const token of left) {
      if (
        !right.some(
          other => other.name === token.name && other.display === token.display && other.isExternal === token.isExternal
        )
      ) {
        messages.push(
          `${sign} ${token.name} ${JSON.stringify(token.display)} (${token.isExternal ? "external" : "internal"})`
        );
      }
    }
  }
  return messages;
}

function main(values) {
  const { states, largeStates, ...actual } = extractErrorState(
    readFileSync(resolve(values.parser || join(root, "src/parser.c")), "utf8")
  );
  console.log(
    `Error state: ${states} parse states, ${largeStates} large states; ` +
      `${actual.tokens.length} tokens (${actual.tokens.filter(token => !token.isExternal).length} internal); ` +
      `${actual.lexState0} parse states use lex state 0.`
  );
  if (values.record) {
    const file = resolve(values.record);
    writeFileSync(file, JSON.stringify(actual, null, 2) + "\n");
    console.log(`Recorded candidate in ${file}; explain every change before replacing expectations.`);
    return;
  }
  const expected = JSON.parse(readFileSync(resolve(values.expect || EXPECTATION), "utf8"));
  const differences = compareErrorState(expected, actual);
  if (differences.length) {
    throw new Error(
      `Error-state expectation mismatch:\n${differences.join("\n")}\n` +
        "See ARCHITECTURE.md#error-state-gate. Record a candidate with --record <file>, " +
        "explain every token change and run the recovery gates."
    );
  }
}

if (require.main === module) {
  try {
    const { values } = parseArgs({
      options: Object.fromEntries(["parser", "expect", "record"].map(name => [name, { type: "string" }]))
    });
    main(values);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}

module.exports = { extractErrorState, compareErrorState };
