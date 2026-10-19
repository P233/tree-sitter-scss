const { Buffer } = require("node:buffer");
const { readFileSync, writeFileSync } = require("node:fs");
const { join, resolve } = require("node:path");
const { parseArgs, TextDecoder } = require("node:util");

const root = join(__dirname, "..");
const EXPECTATION = join(__dirname, "error-state.json");

const SIMPLE_ESCAPES = {
  a: "\x07",
  b: "\b",
  f: "\f",
  n: "\n",
  r: "\r",
  t: "\t",
  v: "\v",
  "'": "'",
  '"': '"',
  "?": "?",
  "\\": "\\"
};

function decodeCString(literal, symbol, file) {
  const body = literal.slice(1, -1);
  const escape = /\\([abfnrtv'"?\\]|[0-7]{1,3}|x[0-9a-fA-F]+|u[0-9a-fA-F]{4}|U[0-9a-fA-F]{8})/y;
  const chunks = [];
  try {
    for (let index = 0; index < body.length;) {
      if (body[index] !== "\\") {
        const next = body.indexOf("\\", index);
        const end = next < 0 ? body.length : next;
        chunks.push(Buffer.from(body.slice(index, end)));
        index = end;
        continue;
      }
      escape.lastIndex = index;
      const match = escape.exec(body);
      if (!match) throw new Error(`Unsupported C escape ${JSON.stringify(body.slice(index, index + 2))}.`);
      index = escape.lastIndex;
      const code = match[1];
      if (Object.hasOwn(SIMPLE_ESCAPES, code)) chunks.push(Buffer.from(SIMPLE_ESCAPES[code]));
      else if (code[0] === "u" || code[0] === "U") {
        const value = Number.parseInt(code.slice(1), 16);
        if (value > 0x10ffff || (value >= 0xd800 && value <= 0xdfff))
          throw new Error(`Invalid C code point ${match[0]}.`);
        chunks.push(Buffer.from(String.fromCodePoint(value)));
      } else {
        const value = code[0] === "x" ? Number.parseInt(code.slice(1), 16) : Number.parseInt(code, 8);
        if (value > 255) throw new Error(`C byte escape is out of range: ${match[0]}.`);
        chunks.push(Buffer.from([value]));
      }
    }
    // Octal/hex escapes form UTF-8 bytes, and a leading BOM belongs to the name.
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(Buffer.concat(chunks));
  } catch (error) {
    throw new Error(`${file}: cannot decode display name for ${symbol}: ${error.message}`, { cause: error });
  }
}

function extractErrorState(source, file = "src/parser.c") {
  const section = name => {
    const match = source.match(new RegExp(`\\b${name}\\[[^;]*?=\\s*\\{([\\s\\S]*?)^\\};`, "m"));
    if (!match) throw new Error(`${file}: ${name} is missing or has an unsupported format.`);
    return match[1];
  };
  const count = name => {
    const match = source.match(new RegExp(`^#define ${name} (\\d+)$`, "m"));
    if (!match) throw new Error(`${file}: ${name} is missing.`);
    return Number(match[1]);
  };
  const names = new Map(
    [...section("ts_symbol_names").matchAll(/\[(\w+)\]\s*=\s*("(?:[^"\\]|\\.)*")/g)].map(([, name, display]) => [
      name,
      decodeCString(display, name, file)
    ])
  );
  const external = new Set(
    [...section("ts_external_scanner_symbol_map").matchAll(/\[\w+\]\s*=\s*(\w+)/g)].map(match => match[1])
  );
  const state = section("ts_parse_table").match(/\[STATE\(0\)\]\s*=\s*\{([^}]+)\}/);
  if (!state) throw new Error(`${file}: parse state 0 is missing.`);
  const tokens = [...state[1].matchAll(/\[(\w+)\]\s*=\s*ACTIONS\(([1-9]\d*)\)/g)]
    .map(([, name]) => {
      if (!names.has(name)) throw new Error(`${file}: display name for ${name} is missing.`);
      return { name, display: names.get(name), isExternal: external.has(name) };
    })
    .sort((a, b) => a.name.localeCompare(b.name, "en"));
  if (!tokens.length) throw new Error(`${file}: parse state 0 has no tokens.`);
  const modes = [...section("ts_lex_modes").matchAll(/\[(\d+)\]\s*=\s*\{\s*\.lex_state\s*=\s*(\d+)\b/g)];
  const states = count("STATE_COUNT");
  if (modes.length !== states) throw new Error(`${file}: expected ${states} lex modes, got ${modes.length}.`);
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
  const parser = resolve(values.parser || join(root, "src/parser.c"));
  const { states, largeStates, ...actual } = extractErrorState(readFileSync(parser, "utf8"), parser);
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
