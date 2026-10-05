// Seeded random-edit differential: record single-edit cases, then compare a baseline recording with a candidate.
const { createHash } = require("node:crypto");
const { closeSync, createReadStream, openSync, readFileSync, readdirSync, writeSync } = require("node:fs");
const { createRequire } = require("node:module");
const { join, resolve } = require("node:path");
const { createInterface } = require("node:readline");
const { setImmediate: yieldToEventLoop } = require("node:timers/promises");
const { parseArgs } = require("node:util");

const root = join(__dirname, "..");
const INPUT_SOURCES = [
  ["test/highlight", ".scss"],
  ["examples", ".scss"],
  ["test/corpus", ".txt"]
];
const FRAGMENTS = [
  ".b .c",
  ".b > .c",
  ".b,",
  "&:is(",
  "@if $a ==",
  "@each $x in",
  "#{",
  "url(",
  "\n",
  "{",
  "}",
  ";",
  ":",
  " ",
  "(",
  ")",
  "[",
  "]",
  ",",
  "&",
  "*",
  "//",
  "/*",
  "*/",
  '"',
  "'",
  ".x",
  "a b",
  "a\n  b",
  "m10",
  "$v",
  "!important",
  "@media",
  "2n+1",
  "--x",
  "#{$a}",
  ":hover",
  "::before",
  ">",
  "+",
  "~",
  "|",
  "@extend .a",
  "@include m",
  "width: 1px;",
  "a:b",
  ".b, .c",
  "&:is(.c",
  "*",
  "*zoom",
  "\n  .b\n",
  "--y: {",
  "@if",
  "$m: (a: 1,",
  "@at-root",
  "b,\n",
  ":",
  "::",
  "#{$x}-y",
  "url(a.png)",
  '"a',
  "p {",
  "}\n",
  // Enter, then an unfinished head: the next existing line follows it, as when a statement is typed above another.
  "\n  >",
  "\n  &[d=]",
  "\n  #{}",
  "\n  .b .",
  "\n  @media (",
  "\n  $x:"
];
const MAX_DELETION = 40;
// Captures farther than this from the edited text belong to other statements; losing one there is remote damage.
const REMOTE_WINDOW = 300;
const EXAMPLE_LIMIT = 10;
const CASE_FIELDS = ["dialect", "case", "input", "inputHash", "start", "del", "insert"];
const isCapture = value => typeof value === "string" && /^[\w.-]+@\d+-\d+$/.test(value);
const FIELD_TYPES = {
  string: [value => typeof value === "string", "a string"],
  count: [value => Number.isSafeInteger(value) && value >= 0, "a non-negative integer"],
  boolean: [value => typeof value === "boolean", "a boolean"],
  captures: [value => Array.isArray(value) && value.every(isCapture), "an array of name@start-end captures"]
};
// Every field compare reads; a record of another shape would otherwise compare as empty and pass.
const RECORD_FIELDS = {
  dialect: "string",
  case: "count",
  input: "string",
  inputHash: "string",
  start: "count",
  del: "count",
  insert: "string",
  hasError: "boolean",
  hasOriginalError: "boolean",
  tree: "string",
  isIncrementalExact: "boolean",
  isRevertExact: "boolean",
  captures: "captures"
};
// The attribute lines Tree-sitter CLI 0.27 recognizes in a corpus test header.
const CORPUS_ATTRIBUTE = /^:(?:(?:skip|error|fail-fast|cst)(?:\(|$)|(?:platform|language)\(.*\)$)/s;
const USAGE = [
  "Usage: node scripts/fuzz.js record [--seed N] [--cases N] [--corpus FILE-LIST] [--repo PATH] [--out FILE]",
  "       node scripts/fuzz.js compare BASE.jsonl CANDIDATE.jsonl"
].join("\n");

const hash = text => createHash("sha256").update(text).digest("hex").slice(0, 16);
const describe = record =>
  `${record.dialect} #${record.case} ${record.input} at ${record.start} -${record.del} +${JSON.stringify(record.insert)}`;

// Mulberry32: one seed reproduces the same edit sequence in every checkout.
function random(seed) {
  let state = seed | 0;
  return bound => {
    state = (state + 0x6d2b79f5) | 0;
    let mixed = Math.imul(state ^ (state >>> 15), 1 | state);
    mixed = (mixed + Math.imul(mixed ^ (mixed >>> 7), 61 | mixed)) ^ mixed;
    return ((mixed ^ (mixed >>> 14)) >>> 0) % bound;
  };
}

// A run of three or more `character`s and the rest of its line, as the Tree-sitter CLI reads a delimiter line.
function delimiter(line, character) {
  let length = 0;
  while (line[length] === character) length++;
  return length < 3 ? null : { length, suffix: line.slice(length).replace(/\r+$/, "") };
}

// Follows Tree-sitter CLI 0.27: a header between "===" lines, then the input before the longest "---" line.
function corpusInputs(source, path) {
  const lines = source.split("\n");
  const fileSuffix = lines.map(line => delimiter(line, "=")?.suffix).find(Boolean) ?? "";
  const isDelimiter = (line, character) => delimiter(line, character)?.suffix === fileSuffix;
  // A blank line before any attribute means the opening "===" line belongs to an input.
  const headerEnd = start => {
    let hasAttribute = false;
    for (let line = start + 1; line < lines.length; line++) {
      if (isDelimiter(lines[line], "=")) return line;
      const text = lines[line].trim();
      if (!text && !hasAttribute) return -1;
      hasAttribute ||= CORPUS_ATTRIBUTE.test(text);
    }
    return -1;
  };
  const headers = [];
  for (let line = 0; line < lines.length; line++) {
    const end = isDelimiter(lines[line], "=") ? headerEnd(line) : -1;
    if (end < 0) continue;
    headers.push({ start: line, end });
    line = end;
  }
  return headers.flatMap((header, index) => {
    const first = header.end + 1;
    const last = index + 1 < headers.length ? headers[index + 1].start : lines.length;
    let divider = -1;
    let dashes = 0;
    for (let line = first; line < last; line++) {
      const match = delimiter(lines[line], "-");
      if (match?.suffix === fileSuffix && match.length >= dashes) {
        divider = line;
        dashes = match.length;
      }
    }
    if (divider < 0) return [];
    return [{ id: `${path}:${first + 1}`, text: lines.slice(first, divider).join("\n").replace(/\r$/, "") }];
  });
}

// Inputs always come from this checkout, so recordings of different checkouts replay identical texts.
function repositoryInputs() {
  return INPUT_SOURCES.flatMap(([directory, extension]) =>
    readdirSync(join(root, directory))
      .filter(name => name.endsWith(extension))
      .sort()
      .flatMap(name => {
        const path = `${directory}/${name}`;
        const text = readFileSync(join(root, path), "utf8");
        return extension === ".txt" ? corpusInputs(text, path) : [{ id: path, text }];
      })
  );
}

function listedInputs(list) {
  return readFileSync(list, "utf8")
    .trim()
    .split(/\r?\n/)
    .filter(Boolean)
    .map(file => ({ id: file, text: readFileSync(file, "utf8") }));
}

// The Node binding counts indices and columns in UTF-16 code units, and only "\n" starts a row.
function position(text, index) {
  let row = 0;
  let lineStart = 0;
  for (let next = text.indexOf("\n"); next !== -1 && next < index; next = text.indexOf("\n", next + 1)) {
    row++;
    lineStart = next + 1;
  }
  return { row, column: index - lineStart };
}

const isHighSurrogate = code => code >= 0xd800 && code <= 0xdbff;
const isLowSurrogate = code => code >= 0xdc00 && code <= 0xdfff;

// An edit inside a surrogate pair would leave half a character in the text.
function boundary(text, index) {
  return isHighSurrogate(text.charCodeAt(index - 1)) && isLowSurrogate(text.charCodeAt(index)) ? index - 1 : index;
}

function nextEdit(next, inputs) {
  const input = next(inputs.length);
  const { text } = inputs[input];
  const start = boundary(text, next(text.length + 1));
  const deleted = next(4) === 0 ? next(Math.min(MAX_DELETION, text.length - start) + 1) : 0;
  const insert = next(5) === 0 ? "" : FRAGMENTS[next(FRAGMENTS.length)];
  return { input, start, del: boundary(text, start + deleted) - start, insert };
}

function inputEdit(before, after, start, oldEnd, newEnd) {
  return {
    startIndex: start,
    oldEndIndex: oldEnd,
    newEndIndex: newEnd,
    startPosition: position(before, start),
    oldEndPosition: position(before, oldEnd),
    newEndPosition: position(after, newEnd)
  };
}

// Every node, named or anonymous, with its field, range and MISSING flag; toString() omits ranges and tokens.
function shape(tree) {
  const cursor = tree.walk();
  const parts = [];
  for (;;) {
    const field = cursor.currentFieldName;
    const type = cursor.nodeIsNamed ? cursor.nodeType : JSON.stringify(cursor.nodeType);
    const missing = cursor.nodeIsMissing ? " MISSING" : "";
    parts.push(`${field ? `${field}:` : ""}(${type} ${cursor.startIndex}-${cursor.endIndex}${missing}`);
    if (cursor.gotoFirstChild()) continue;
    parts.push(")");
    while (!cursor.gotoNextSibling()) {
      if (!cursor.gotoParent()) return parts.join("");
      parts.push(")");
    }
  }
}

async function* recordCases({ Parser, language, highlightsQuery, inputs, seed, cases }) {
  const parser = new Parser();
  parser.setLanguage(language);
  const query = new Parser.Query(language, highlightsQuery);
  const inputHashes = inputs.map(input => hash(input.text));
  const originals = new Map();
  const next = random(seed);
  for (let index = 0; index < cases; index++) {
    // Native trees are freed by finalizers that run only after control returns to the event loop.
    await yieldToEventLoop();
    const { input, start, del, insert } = nextEdit(next, inputs);
    const original = inputs[input].text;
    const text = original.slice(0, start) + insert + original.slice(start + del);
    if (!originals.has(input)) {
      const tree = parser.parse(original);
      originals.set(input, { shape: shape(tree), hasError: tree.rootNode.hasError });
    }
    const before = originals.get(input);
    const fresh = parser.parse(text);
    const freshShape = shape(fresh);
    const previous = parser.parse(original);
    previous.edit(inputEdit(original, text, start, start + del, start + insert.length));
    const incremental = parser.parse(text, previous);
    const isIncrementalExact = shape(incremental) === freshShape;
    incremental.edit(inputEdit(text, original, start, start + insert.length, start + del));
    const reverted = parser.parse(original, incremental);
    yield {
      dialect: language.name,
      case: index,
      input: inputs[input].id,
      inputHash: inputHashes[input],
      start,
      del,
      insert,
      hasError: fresh.rootNode.hasError,
      hasOriginalError: before.hasError,
      tree: hash(freshShape),
      isIncrementalExact,
      isRevertExact: shape(reverted) === before.shape,
      captures: query
        .captures(fresh.rootNode)
        .filter(({ node }) => node.endIndex > node.startIndex)
        .map(({ name, node }) => `${name}@${node.startIndex}-${node.endIndex}`)
    };
  }
}

function createSummary() {
  return { dialects: {}, examples: { clean: [], error: [] } };
}

// An error-free tree must survive incremental parsing; error-tree mismatches are known runtime and recovery debt.
function tally(summary, record) {
  const counts = (summary.dialects[record.dialect] ??= {
    cases: 0,
    errorTrees: 0,
    incrementalMismatches: { clean: 0, error: 0 },
    revertFailures: { clean: 0, error: 0 }
  });
  counts.cases++;
  if (record.hasError) counts.errorTrees++;
  if (!record.isIncrementalExact) {
    countFailure(summary, counts.incrementalMismatches, record.hasError, `incremental: ${describe(record)}`);
  }
  if (!record.isRevertExact) {
    countFailure(summary, counts.revertFailures, record.hasOriginalError, `revert: ${describe(record)}`);
  }
}

function countFailure(summary, counts, hasError, example) {
  const kind = hasError ? "error" : "clean";
  counts[kind]++;
  if (summary.examples[kind].length < EXAMPLE_LIMIT) summary.examples[kind].push(example);
}

function hasCleanFailure(summary) {
  return Object.values(summary.dialects).some(
    counts => counts.incrementalMismatches.clean > 0 || counts.revertFailures.clean > 0
  );
}

function isRemote(capture, record) {
  const [, start, end] = /(\d+)-(\d+)$/.exec(capture).map(Number);
  return end < record.start - REMOTE_WINDOW || start > record.start + record.insert.length + REMOTE_WINDOW;
}

function missingFrom(captures, other) {
  const kept = new Set(other);
  return [...new Set(captures)].filter(capture => !kept.has(capture));
}

// Both recordings must replay the same cases; only their parse results may differ.
function checkAligned(index, base, candidate) {
  const hint = "Record both with the same --seed, --cases and --corpus.";
  if (base.done !== candidate.done) {
    throw new Error(
      `Recordings are not aligned: the ${base.done ? "baseline" : "candidate"} ends at line ${index + 1}. ${hint}`
    );
  }
  const field = base.done ? undefined : CASE_FIELDS.find(name => base.value[name] !== candidate.value[name]);
  if (field) {
    const values = [base.value[field], candidate.value[field]].map(value => JSON.stringify(value));
    throw new Error(`Recordings are not aligned at line ${index + 1}: ${field} ${values.join(" vs ")}. ${hint}`);
  }
}

// Captures are compared only where trees differ; identical trees with different captures mean the queries differ.
async function compare(base, candidate) {
  const report = {
    cases: 0,
    cleanDiff: 0,
    errTreeDiff: 0,
    lossCases: 0,
    lostCaps: 0,
    gainCases: 0,
    gainedCaps: 0,
    remoteLossCases: 0,
    remoteLostCaps: 0,
    remoteGainCases: 0,
    remoteGainedCaps: 0,
    localOnlyLossCases: 0,
    captureOnlyDiff: 0
  };
  const summaries = { base: createSummary(), candidate: createSummary() };
  const examples = { clean: [], remoteLoss: [], loss: [] };
  const remoteLosses = [];
  const iterate = records => records[Symbol.asyncIterator]?.() ?? records[Symbol.iterator]();
  const baseRecords = iterate(base);
  const candidateRecords = iterate(candidate);
  for (;;) {
    const [x, y] = await Promise.all([baseRecords.next(), candidateRecords.next()]);
    checkAligned(report.cases, x, y);
    if (x.done) break;
    const [before, after] = [x.value, y.value];
    report.cases++;
    tally(summaries.base, before);
    tally(summaries.candidate, after);
    const lost = missingFrom(before.captures, after.captures);
    const gained = missingFrom(after.captures, before.captures);
    if (before.tree === after.tree) {
      if (lost.length || gained.length) report.captureOnlyDiff++;
      continue;
    }
    // A clean difference fails by itself, so every loss and gain count covers the same error-tree differences.
    if (!before.hasError) {
      report.cleanDiff++;
      if (examples.clean.length < EXAMPLE_LIMIT) examples.clean.push(describe(before));
      continue;
    }
    report.errTreeDiff++;
    if (lost.length) {
      report.lossCases++;
      report.lostCaps += lost.length;
      if (examples.loss.length < EXAMPLE_LIMIT) {
        examples.loss.push(`${describe(before)}: lost ${lost.slice(0, 6).join(" ")}; gained ${gained.length}`);
      }
    }
    if (gained.length) {
      report.gainCases++;
      report.gainedCaps += gained.length;
    }
    const remoteLost = lost.filter(capture => isRemote(capture, before));
    const remoteGained = gained.filter(capture => isRemote(capture, before));
    if (remoteLost.length) {
      report.remoteLossCases++;
      report.remoteLostCaps += remoteLost.length;
      remoteLosses.push([remoteLost.length, `${describe(before)}: lost ${remoteLost.slice(0, 4).join(" ")}`]);
    } else if (lost.length) {
      report.localOnlyLossCases++;
    }
    if (remoteGained.length) {
      report.remoteGainCases++;
      report.remoteGainedCaps += remoteGained.length;
    }
  }
  if (report.cases === 0) throw new Error("The recordings contain no cases.");
  examples.remoteLoss = remoteLosses
    .sort((a, b) => b[0] - a[0])
    .slice(0, EXAMPLE_LIMIT)
    .map(([, example]) => example);
  return { ...report, base: summaries.base, candidate: summaries.candidate, examples };
}

async function* readRecords(file) {
  let number = 0;
  for await (const line of createInterface({ input: createReadStream(file), crlfDelay: Infinity })) {
    number++;
    if (!line) continue;
    let record;
    try {
      record = JSON.parse(line);
    } catch (error) {
      throw new Error(`${file}:${number}: ${error.message}`);
    }
    for (const [field, type] of Object.entries(RECORD_FIELDS)) {
      const [isValid, description] = FIELD_TYPES[type];
      if (!isValid(record?.[field])) throw new Error(`${file}:${number}: ${field} must be ${description}.`);
    }
    yield record;
  }
}

function integer(value, name, fallback, minimum) {
  if (value === undefined) return fallback;
  const number = Number(value);
  if (!/^\d+$/.test(value) || !Number.isSafeInteger(number) || number < minimum) {
    throw new Error(`--${name} must be an integer of at least ${minimum}.\n${USAGE}`);
  }
  return number;
}

async function recordCommand(options) {
  const seed = integer(options.seed, "seed", 1, 0);
  const cases = integer(options.cases, "cases", 5000, 1);
  const checkout = resolve(options.repo || root);
  const local = createRequire(join(checkout, "package.json"));
  const Parser = local("tree-sitter");
  const Scss = local("./bindings/node");
  const inputs = [...repositoryInputs(), ...(options.corpus ? listedInputs(options.corpus) : [])];
  const highlightsQuery = Scss.HIGHLIGHTS_QUERY;
  const summary = createSummary();
  const output = options.out === undefined ? undefined : openSync(options.out, "w");
  try {
    for (const language of [Scss, Scss.cssLanguage]) {
      for await (const result of recordCases({ Parser, language, highlightsQuery, inputs, seed, cases })) {
        if (output !== undefined) writeSync(output, `${JSON.stringify(result)}\n`);
        tally(summary, result);
      }
    }
  } finally {
    if (output !== undefined) closeSync(output);
  }
  const runtime = local("tree-sitter/package.json").version;
  console.log(JSON.stringify({ checkout, runtime, seed, cases, inputs: inputs.length, ...summary }, null, 2));
  return hasCleanFailure(summary) ? 1 : 0;
}

async function compareCommand(baseFile, candidateFile) {
  const report = await compare(readRecords(baseFile), readRecords(candidateFile));
  console.log(JSON.stringify(report, null, 2));
  return report.cleanDiff > 0 || report.remoteLossCases > 0 ? 1 : 0;
}

async function main(args) {
  const names = ["seed", "cases", "corpus", "repo", "out"];
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: Object.fromEntries(names.map(name => [name, { type: "string" }]))
  });
  const [command, ...files] = positionals;
  if (command === "record" && files.length === 0) return recordCommand(values);
  if (command === "compare" && files.length === 2 && Object.keys(values).length === 0) return compareCommand(...files);
  throw new Error(USAGE);
}

if (require.main === module) {
  main(process.argv.slice(2)).then(
    status => {
      process.exitCode = status;
    },
    error => {
      console.error(error.message);
      process.exitCode = 2;
    }
  );
}

module.exports = {
  corpusInputs,
  repositoryInputs,
  position,
  nextEdit,
  shape,
  recordCases,
  createSummary,
  tally,
  hasCleanFailure,
  compare
};
