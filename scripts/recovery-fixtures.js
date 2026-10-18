const contractStatements = {
  header: [
    "@media screen and (min-width: 600px) {",
    "@include breakpoint(md) {",
    "@if $theme == dark {",
    "@each $name, $glyph in $icons {",
    "@supports (display: grid) {",
    "@at-root .x {",
    "@container card (min-width: 400px) {",
    "@include button-variant($primary, $radius: 4px);",
    "@extend %placeholder;",
    "@for $n from 1 through 3 {",
    "@while $i > 0 {",
    "@media (min-width: 600px) and (max-width: 900px) {",
    "@supports not (display: grid) {",
    "@layer base {",
    '@debug "gap: #{$gap}";',
    '@warn "deprecated";',
    "@include breakpoint(md);"
  ],
  selector: [
    ".card:hover > .title {",
    "&__element--modifier {",
    'a[href^="http"]:not(.internal) {',
    "#{$sel} .child {",
    ".a, .b {",
    "> li + li {",
    "&:nth-child(2n + 1) {",
    ".a:not(.b):hover::before {",
    'input[type="checkbox"]:checked + label {',
    ".grid > * {",
    "&.is-active {",
    "& + & {",
    "html, body {",
    "ul li a {",
    "%placeholder-x {",
    "~ .sibling {",
    "&::after {",
    "#main .content {"
  ],
  declaration: [
    "margin: 0 auto;",
    "color: map.get($theme, primary);",
    "width: calc(100% - #{$gap});",
    'font-family: "Helvetica Neue", sans-serif;',
    'background: url("a.png") no-repeat;',
    "transition: opacity 0.2s ease-in-out, transform 0.2s;",
    "grid-template-columns: repeat(auto-fill, minmax(10rem, 1fr));",
    "$local: 10px;",
    "color: red !important;",
    "--accent: #{$brand};",
    "color: #fff;",
    "margin: -$gap auto;",
    "width: math.div($gap, 2);",
    "font: 12px/1.5 $font-stack;",
    'content: "";',
    "border: 1px solid rgba(0, 0, 0, 0.1);",
    "transform: translate(-50%, -50%) rotate(45deg);",
    "background-image: linear-gradient(to right, red, blue);",
    "font-size: clamp(1rem, 2vw + 1rem, 3rem);",
    "width: calc(100% - min(2rem, 5vw));",
    "margin: max(1px, min(2px, 3px));"
  ],
  variable: ["$local: 10px;", "$map: (key: value, other: 2px);", "$list: 1px 2px 3px !default;"]
};
const contractBefore = [
  '@use "sass:map";',
  '@use "sass:math";',
  "$gap: 8px;",
  ".intro {",
  "  color: red;",
  "  &:hover { color: blue; }",
  "}"
].join("\n");
const contractLayouts = {
  above: ["\n.panel {\n  padding: 4px;\n  ", "\n  width: 1px;\n  .inner { margin: 0; }\n}\n"],
  end: ["\n.panel {\n  padding: 4px;\n  width: 1px;\n  ", "\n}\n"],
  nested: [
    "\n.panel {\n  padding: 4px;\n  @media print {\n    color: black;\n    ",
    "\n    width: 1px;\n  }\n  height: 2px;\n}\n"
  ],
  top: ["\n", "\n.panel {\n  padding: 4px;\n}\n"]
};

const typingStatements = [
  ".b { color: blue; }",
  ".b, .c { color: blue; }",
  ".b > .c:hover { color: blue; }",
  "&:is(.c, .d) { color: blue; }",
  "&-x { color: blue; }",
  '[data-x="a"] { color: blue; }',
  "a:nth-child(2n + 1) { color: blue; }",
  "color: blue;",
  "margin: 1px + 2px;",
  "width: calc(1px + 2px);",
  "$x: (a: 1, b: 2);",
  "--x: 1px;",
  "background: url(a.png);",
  'content: "a #{$b} c";',
  "width: #{$a}px;",
  ".b-#{$x} { color: blue; }",
  "@include m(1, $a: 2);",
  "@extend .x;",
  "@media (min-width: 1px) { color: blue; }",
  "@if $a == 1 { color: blue; } @else { color: red; }",
  "@each $x in (a, b) { color: blue; }",
  "/* note #{$a} */",
  "// note",
  "m10",
  "transition: color .2s ease, width .2s;",
  "@include m { color: blue; }",
  "&:hover, &:focus { color: blue; }",
  "$map: (a: (b: 1));",
  "font: #{$s}/#{$l} $f;",
  "> .c { color: blue; }",
  "+ .c { color: blue; }",
  "~ .c { color: blue; }",
  '&[data-state="open"] { color: blue; }',
  "#{$sel} { color: blue; }"
];

const blockStatements = [
  "&:",
  ".b:",
  "&.",
  "&#",
  "&[",
  "&[]",
  ".b []",
  "&:is(",
  "&:not(.)",
  "#{$sel}",
  "> .b:",
  "a.b:",
  "a[",
  "p::",
  "li:not(.)",
  "ul li:hover:",
  "svg|a:",
  "&:hover",
  ".b >",
  ".b,",
  "&::before:",
  ".b .c:",
  "&-x:",
  "width: calc(100% - max(1px, 2px));",
  "width: calc(1px + min(2px, 3px));",
  "width: calc(2 * max(1px, 2px));",
  "width: calc(1px * pow(2, 3));",
  "width: calc(100vw - env(x, 0));",
  "width: calc(100% - fn(1px, 2px));",
  "inset: calc(50% - var(--x, 4px));",
  "width: calc(100% - (1px + 2px));",
  "width: min(100%, max(1px, 2px));",
  "width: fn(1px, max(2px, 3px));",
  "width: calc(100% - min(2rem, 5vw));",
  "margin: max(1px, min(2px, 3px));"
];

const headers = [
  "@if $a == 1",
  "@each $x in a, b",
  "@for $i from 1 through 3",
  "@while $i > 0",
  "@media (min-width: 1px)",
  "@media screen and (color)",
  "@supports (display: grid)",
  "@container card (min-width: 1px)",
  "@at-root .x",
  "@include m(1px)",
  "@mixin m($a)",
  "@function f($a)",
  "@page :first",
  "@scope (.a) to (.b)",
  "@layer base",
  "@starting-style",
  "@else if $a",
  "@keyframes fade"
];

// Lines left unfinished where a header is then typed, on the next line or after them, grouped by how they end.
const unfinishedLines = {
  compound: [
    "b",
    "&:hover",
    ".b",
    "a.b",
    "&.c",
    "&-x",
    ".b:hover",
    ".b::before",
    "a[href]",
    "*",
    "#id",
    "%ph",
    "#{$s}",
    ".b #{$x}"
  ],
  combinator: ["> .b", ".b .c", "ul > li", ".b:not(.c)", "~ a", "+ a"],
  punctuation: [".b,", ".b >", ".b +", ".b ~", ".b:", ".b.", ".b, .c"],
  marker: [".b .", ".b #", ".b :", ".b ::", ".b %", ".b [", "a #", "&:hover ."],
  group: ["&[d", "&[d=", '&[d="x"', "&:is(", "&:is(.c", "&:not(.c,", "&:nth-child(2n of .c"],
  other: ["color", "color:", "color: red", "@include m", "$x: 1", "margin: fn(1px,"]
};

const unfinishedHeaders = [
  "@media",
  "@media screen",
  "@if $a",
  "@supports (a: b)",
  "@each $x in a",
  "@layer x",
  "@include m",
  "@at-root"
];

const typos = {
  "space-in-name": ".a { cur sor: x; }",
  "stray-letter": ".a { a  display: flex; }",
  "digit-before-decl": ".a { 1 z-index: 2; }",
  "word-before-decl-multiline": ".a {\n  c width: 1px;\n}",
  "touching-colon": ".a { op:acity: 0.4; }",
  "colon-before-decl": ".a {\n  color:width: 1px;\n}",
  "space-in-name-multiline": ".a {\n  color: red;\n  dis play: flex;\n  width: 1px;\n}",
  "nested-typo": ".a {\n  .b {\n    marg in: 0;\n  }\n}"
};

const point = (text, index) => {
  const before = text.slice(0, index);
  return { row: before.split("\n").length - 1, column: index - before.lastIndexOf("\n") - 1 };
};

function inputEdit(before, after, start, oldEnd, newEnd) {
  return {
    startIndex: start,
    oldEndIndex: oldEnd,
    newEndIndex: newEnd,
    startPosition: point(before, start),
    oldEndPosition: point(before, oldEnd),
    newEndPosition: point(after, newEnd)
  };
}

function* typingStates(before, after, statement, pairs, includeOvertypes = false) {
  let text = before + after;
  let caret = before.length;
  const closers = Object.values(pairs);
  for (const typed of statement) {
    if (text[caret] === typed && closers.includes(typed)) {
      caret++;
      if (includeOvertypes) yield { text };
      continue;
    }
    const inserted = typed + (pairs[typed] || "");
    const previous = text;
    text = text.slice(0, caret) + inserted + text.slice(caret);
    yield {
      text,
      edit: inputEdit(previous, text, caret, caret, caret + inserted.length)
    };
    caret++;
  }
}

const rules = (name, count = 300) =>
  Array.from({ length: count }, (_, i) => `.${name}${i} {\n  margin: ${i}px;\n  &:hover { color: red; }\n}\n`).join("");

function typingLayouts() {
  const head = rules("h", 500);
  const tail = recoveryFamilies.typing.tail;
  return {
    blank: [`${head}.a {\n  color: red;\n  `, `\n  width: 1px;\n}\n${tail}`],
    same: [`${head}.a {\n  color: red;\n  `, `width: 1px;\n}\n${tail}`],
    end: [`${head}.a {\n  color: red;\n  `, `\n}\n${tail}`],
    top: [head, `\n${tail}`],
    nested: [`${head}.a {\n  `, `\n  &:hover { color: red; }\n  width: 1px;\n}\n${tail}`]
  };
}

function blockLayouts() {
  const head = rules("h");
  const tail = recoveryFamilies.blockend.tail;
  return {
    end: [`${head}.a {\n  color: red;\n  `, `\n}\n${tail}`],
    nested: [`${head}.p {\n  .a {\n    color: red;\n    `, `\n  }\n  width: 1px;\n}\n${tail}`],
    oneline: [`${head}.a { color: red; `, ` }\n${tail}`]
  };
}

function headerLayouts() {
  const tail = recoveryFamilies.headers.tail;
  return {
    newline: [`.a {\n  color: red;\n  `, `\n}\n${tail}`],
    sameline: [`.a { color: red; `, ` }\n${tail}`],
    nested: [`.p {\n  .a {\n    color: red;\n    `, `\n  }\n  width: 1px;\n}\n${tail}`],
    afterif: [`.a {\n  @if $x { color: red; }\n  `, `\n}\n${tail}`]
  };
}

function unfinishedLayouts() {
  const tail = recoveryFamilies.unfinished.tail;
  return {
    next: [line => `.a {\n  color: red;\n  ${line}\n  `, `\n}\n${tail}`],
    same: [line => `.a {\n  color: red;\n  ${line} `, `\n}\n${tail}`]
  };
}

const typoTail = Array.from({ length: 300 }, (_, i) => `.t${i} { margin: ${i}px; }`).join("\n");

const recoveryFamilies = {
  contract: {
    statements: contractStatements,
    before: contractBefore,
    layouts: category =>
      Object.entries(contractLayouts).filter(([layout]) => category !== "declaration" || layout !== "top"),
    tail: rules("t", 60),
    pairs: { "(": ")", "[": "]", '"': '"', "{": "}" },
    includeOvertypes: true
  },
  typing: {
    statements: typingStatements,
    layouts: typingLayouts,
    tail: rules("t", 500),
    pairs: { "(": ")", "[": "]", "{": "}", '"': '"' }
  },
  blockend: {
    statements: blockStatements,
    layouts: blockLayouts,
    tail: rules("t"),
    pairs: { "(": ")", "[": "]", "{": "}" }
  },
  headers: {
    statements: headers,
    layouts: headerLayouts,
    tail: rules("t"),
    pairs: { "(": ")", "[": "]" }
  },
  unfinished: {
    lines: unfinishedLines,
    statements: unfinishedHeaders,
    layouts: unfinishedLayouts,
    tail: rules("t"),
    pairs: {}
  },
  typos: {
    statements: typos,
    tail: typoTail,
    source: head => `${head}\n${typoTail}\n`
  }
};

// Regions are source coordinates, independent of either parse; an if/else chain stays inside the editable block.
function protectedRegions(before, after, prefixEnd, tail) {
  const source = before + after;
  return [
    ...(prefixEnd ? [{ name: "before-block", start: 0, end: prefixEnd }] : []),
    { name: "tail-rules", start: source.length - tail.length, end: source.length }
  ];
}

function* recoveryFixtures() {
  let index = 0;
  const contract = recoveryFamilies.contract;
  for (const [category, statements] of Object.entries(contract.statements)) {
    for (const statement of statements) {
      const layouts = contract.layouts(category);
      const [layout, [pre, post]] = layouts[index % layouts.length];
      const mode = index++ % 2 ? "plain" : "paired";
      const before = contract.before + pre;
      const tail = contract.tail;
      const after = post + tail;
      yield {
        family: "contract",
        key: `${category}/${layout}/${statement}`,
        statement,
        mode,
        before,
        after,
        pairs: mode === "plain" ? {} : contract.pairs,
        includeOvertypes: contract.includeOvertypes,
        regions: protectedRegions(before, after, contract.before.length, tail)
      };
    }
  }
  for (const family of ["typing", "blockend", "headers"]) {
    const parameters = recoveryFamilies[family];
    const layouts = parameters.layouts();
    index = 0;
    for (const statement of parameters.statements) {
      let [layout, [before, after]] = Object.entries(layouts)[index % Object.keys(layouts).length];
      if (
        family === "typing" &&
        layout === "top" &&
        ['content: "a #{$b} c";', "m10", "font: #{$s}/#{$l} $f;"].includes(statement)
      ) {
        // These top-level inputs absorb the first tail rule; use the existing block layout.
        layout = "blank";
        [before, after] = layouts[layout];
      }
      const isEven = index++ % 2 === 0;
      const mode = family === "headers" || isEven ? "paired" : "plain";
      const dialect = family === "blockend" && !isEven ? "css" : "scss";
      const prefixEnd = before.indexOf(layout === "nested" && family !== "typing" ? ".p {" : ".a {");
      yield {
        family,
        key: family === "blockend" ? `${dialect}/${layout}/${statement}` : `${layout}/${statement}`,
        statement,
        mode,
        dialect,
        before,
        after,
        pairs: mode === "plain" ? {} : parameters.pairs,
        includeOvertypes: parameters.includeOvertypes,
        regions: protectedRegions(before, after, prefixEnd < 0 ? before.length : prefixEnd, parameters.tail)
      };
    }
  }
  index = 0;
  const unfinished = recoveryFamilies.unfinished;
  for (const [category, lines] of Object.entries(unfinished.lines)) {
    for (const line of lines) {
      const layout = index % 2 ? "same" : "next";
      const statement = unfinished.statements[index++ % unfinished.statements.length];
      const [prefix, after] = unfinished.layouts()[layout];
      const before = prefix(line);
      const complete = prefix("") + after;
      const tail = unfinished.tail;
      yield {
        family: "unfinished",
        key: `${layout}/${line}/${statement}`,
        category,
        statement,
        mode: "paired",
        before,
        after,
        complete,
        pairs: unfinished.pairs,
        includeOvertypes: unfinished.includeOvertypes,
        regions: protectedRegions(prefix(""), after, 0, tail)
      };
    }
  }
  const typo = recoveryFamilies.typos;
  for (const [name, head] of Object.entries(typo.statements)) {
    for (const dialect of ["scss", "css"]) {
      const complete = typo.source(".a {}");
      yield {
        family: "typos",
        key: `${dialect}/${name}`,
        statement: head,
        mode: "paired",
        dialect,
        complete,
        text: typo.source(head),
        regions: protectedRegions(".a {}", typo.source(""), 0, typo.tail + "\n")
      };
    }
  }
}

module.exports = {
  point,
  inputEdit,
  recoveryFamilies,
  typingStates,
  contractStatements,
  contractBefore,
  contractLayouts,
  typingStatements,
  blockStatements,
  headers,
  unfinishedLines,
  unfinishedHeaders,
  typos,
  recoveryFixtures
};
