// Complete statements that recovery lookahead must leave to the grammar.
const PRELUDE =
  '$a: 1; $b: 2; $n: 3; $x: item; $p: color; $sel: ".nested";\n@mixin m($a: 1) { width: $a; }\n@function fn($b: 1, $rest...) { @return $b; }\n';
const SELECTORS = [
  "&:hover",
  ".child",
  "%placeholder",
  "#child",
  '[data-x="a"]',
  ":is(.a, .b)",
  "*",
  "> .child",
  "+ .child",
  "~ .child",
  "#{$sel}",
  "#{$sel}-#{$x}",
  "a#{$x}",
  "a.b",
  "a#child",
  "a[data-x]",
  "ul > li",
  "svg|a",
  ".a\\}b",
  ".a\\[b",
  ".a\\;b",
  ".\\31 23",
  ".颜色😀"
];
const TEMPLATES = [
  ...SELECTORS.map(selector => [`selector/${selector}`, ({ gap, colon }) => `${selector}${gap}{ width${colon}1px; }`]),
  ["selector/comma", ({ gap }) => `.a,${gap}.b { color: red; }`],
  ["selector/combinator", ({ gap }) => `.a >${gap}.b { color: red; }`],
  ["selector/attribute", ({ gap }) => `&[${gap}data-x="a"${gap}] { color: red; }`],
  ["selector/arguments", ({ gap }) => `&:is(${gap}.a,${gap}.b${gap}) { color: red; }`],
  ["selector/comment", ({ gap }) => `a/* selector */ >${gap}.b { color: red; }`],
  ["header/if-hash", ({ gap }) => `@if item ==${gap}#name { color: red; }`],
  ["header/if-modulo", ({ gap }) => `@if $n${gap}% 2 == 1 { color: red; }`],
  ["header/if-comparison", ({ gap }) => `@if $a ==${gap}$b { color: red; }`],
  ["header/else", ({ gap }) => `@if false { color: red; }${gap}@else if $a <${gap}$b { color: blue; }`],
  ["header/each-hash", ({ gap }) => `@each $i in one,${gap}#name { color: $i; }`],
  [
    "header/each-map",
    ({ gap, colon }) => `@each $k, $v in (${gap}width${colon}1px,${gap}height${colon}2px) { #{$k}: $v; }`
  ],
  ["header/for", ({ gap }) => `@for $i from 1 through${gap}$n { width: $i * 1px; }`],
  ["header/while", ({ gap }) => `@while $a >${gap}$b { $a: 0; }`],
  ["header/mixin", ({ gap, colon }) => `@mixin inner(${gap}$a${colon}1${gap})${gap}{ width: $a; }`],
  ["header/function", ({ gap, colon }) => `@function inner(${gap}$a${colon}1${gap})${gap}{ @return $a; }`],
  ["header/keyframes", ({ gap, colon }) => `@keyframes pulse { .5%${gap}{ opacity${colon}0; } }`],
  ["header/media", ({ gap, colon }) => `@media screen and${gap}(min-width${colon}1px) { color: red; }`],
  ["header/supports", ({ gap, colon }) => `@supports${gap}(display${colon}grid) { color: red; }`],
  ["header/container", ({ gap }) => `@container sidebar${gap}(width > 1px) { color: red; }`],
  ["header/container-without-prelude", ({ gap }) => `@container${gap}{ color: red; }`],
  ["header/layer", ({ gap }) => `@layer${gap}components { color: red; }`],
  ["header/layer-statement", ({ gap }) => `@layer base,${gap}components;`],
  ["header/scope", ({ gap }) => `@scope (.a)${gap}to (.b) { color: red; }`],
  ["header/starting-style", ({ gap }) => `@starting-style${gap}{ color: red; }`],
  ["header/at-root", ({ gap }) => `@at-root${gap}.a\\}b { color: red; }`],
  ["header/page", ({ gap }) => `@page${gap}:first { margin: 1px; }`],
  // Sass passes these through without a block, also as a block's last statement.
  ["header/bodiless-container", ({ gap }) => `.child { @container sidebar${gap}(width > 1px) }`],
  ["header/bodiless-container-without-prelude", () => `.child { @container }`],
  ["header/bodiless-layer", ({ gap }) => `.child { @layer${gap}components }`],
  ["header/bodiless-starting-style", () => `.child { @starting-style }`],
  ["header/bodiless-media-case", ({ gap, colon }) => `.child { @MEDIA screen and${gap}(min-width${colon}1px) }`],
  ["header/bodiless-supports-case", ({ gap, colon }) => `.child { @Supports${gap}(display${colon}grid) }`],
  ["value/declaration", ({ colon }) => `font${colon}bold;`],
  ["value/interpolated-name", ({ gap, colon }) => `#{$p}${colon}${gap}red;`],
  ["value/final-interpolated-name", ({ colon }) => `.child { #{$p}${colon}red }`],
  ["value/map", ({ gap, colon }) => `$map: (${gap}width${colon}1px,${gap}height${colon}2px${gap});`],
  ["value/variable-continuation", () => "color: red\n  $a $b;"],
  ["value/list", ({ gap }) => `margin: 1px${gap}2px;`],
  ["value/function", ({ gap }) => `width: calc(1px +${gap}2px);`],
  ["value/css-if", ({ gap, colon }) => `width: if(${gap}style(--x)${colon}1px;${gap}else${colon}2px;${gap});`],
  ["value/include", ({ gap, colon }) => `@include m(${gap}$a${colon}2px${gap});`],
  ["value/url", ({ gap }) => `background: url(${gap}"https://a.test/x.png"${gap});`],
  ["value/string", ({ gap }) => `content: "a; } #{$x} \\\"b"${gap}"c";`],
  ["value/comment", ({ gap }) => `color: red${gap}/* width: 1px; } */;`],
  ["value/interpolation", ({ gap }) => `width: #{1 +${gap}2}px;`],
  ["raw/value", ({ gap, colon }) => `--theme: {${gap}width${colon}1px;${gap}height${colon}2px; };`],
  ["raw/apply", ({ gap, colon }) => `@apply tokens${gap}width${colon}1px;`],
  ["raw/custom-selector", ({ gap }) => `@custom-selector :--heading${gap}h1, h2;`],
  ["raw/unknown", ({ gap, colon }) => `@unknown tokens${gap}width${colon}1px;`]
];

function validInputs() {
  const inputs = [];
  const add = (id, body, indent, newline, hasKnownError = false) => {
    const before = `${PRELUDE}.host {\n  color: red;\n${indent}`.replaceAll("\n", newline);
    body = body.replaceAll("\n", newline);
    const after = "\n  height: 2px;\n}\n.after { width: 1px; }\n".replaceAll("\n", newline);
    inputs.push({
      id: `valid/${id}`,
      text: before + body + after,
      start: before.length,
      end: before.length + body.length,
      hasKnownError
    });
  };
  for (const [name, template] of TEMPLATES) {
    const seen = new Set();
    for (const [gapIndex, gap] of [" ", "\n  ", "\n/* gap */\n  "].entries()) {
      for (const [colonIndex, colon] of [":", ": ", " :", "\n  :\n  "].entries()) {
        const body = template({ gap, colon });
        if (seen.has(body)) continue;
        seen.add(body);
        for (const [indentIndex, indent] of ["", "  ", "\t"].entries()) {
          for (const [newlineIndex, newline] of ["\n", "\r\n"].entries()) {
            // URL payload tokens claim a leading comment before a quoted argument; this syntax gap stays explicit.
            const hasKnownError = name === "value/url" && gapIndex === 2;
            add(
              `${name}/${gapIndex}-${colonIndex}-${indentIndex}-${newlineIndex}`,
              body,
              indent,
              newline,
              hasKnownError
            );
          }
        }
      }
    }
  }
  for (const length of [1022, 1023, 1024, 1025, 1026]) {
    for (const newline of ["\n", "\r\n"]) {
      add(`budget/${length}/${newline.length}`, `&[data-x="${"x".repeat(length)}"] { color: red; }`, "  ", newline);
      add(
        `comment/${length}/${newline.length}`,
        `@media /*${"x".repeat(length)}*/ screen { color: red; }`,
        "  ",
        newline
      );
    }
  }
  add("value/named-argument-closed-on-its-line", ".a {\n  color: fn(\n  $b: 2);\n}", "  ", "\n");
  add("value/named-argument-closed-on-a-later-line", ".a {\n  color: fn(\n  $b: 2\n  );\n}", "  ", "\n");
  add("raw/variable-text-in-a-custom-property", ".a {\n  --x: red\n  $x: 1;\n}", "  ", "\n");
  add("value/comment-closer-in-a-closed-call", ".a {\n  color: fn(1, // )\n    2);\n}", "  ", "\n");
  add("header/comment-closer-in-a-media-feature", ".a {\n  @media (width: 1px // )\n  ) { .b {} }\n}", "  ", "\n");
  add("value/protocol-relative-url", ".a {\n  background: url(//host);\n}", "  ", "\n");
  add("value/url-containing-a-semicolon", ".a {\n  background: url(http://host/a;b);\n}", "  ", "\n");
  add("value/comment-markers-inside-a-string", '.a {\n  content: "// ) ;";\n}', "  ", "\n");
  add("raw/comment-markers-inside-a-raw-custom-value", ".a {\n  --x: fn(//literal);\n}", "  ", "\n");
  add("value/comment-after-a-complete-property", ".a {\n  color: red; // { ;\n  width: 1px;\n}", "  ", "\n");
  add("value/block-opener-inside-a-string", '.a {\n  content: "// { ;";\n}', "  ", "\n");
  add("raw/comment-markers-in-a-custom-property", ".a {\n  --x: // literal;\n}", "  ", "\n");
  add(
    "value/an-open-if-keeps-later-lines-past-a-commented-terminated-line",
    ".a {\n  width: if(\n    style(--x): 1px;\n    else: 2px; // wide\n  );\n}",
    "  ",
    "\n"
  );
  add("value/line-comment-before-a-variable-colon", ".a {\n  $local // todo\n  : 1;\n}", "  ", "\n");
  add("value/block-comment-before-a-variable-colon", ".a {\n  $local /* todo */\n  : 1;\n}", "  ", "\n");
  return inputs;
}

// The last body character is beyond the statement start that recovery lookahead may have inspected.
function validEdits(inputs) {
  return inputs.flatMap(({ start, end }, input) => [
    { input, start: 0, del: 0, insert: "" },
    { input, start, del: 0, insert: "[" },
    { input, start: end - 1, del: 1, insert: "" }
  ]);
}

function checkSass(inputs, sass) {
  for (const { id, text } of inputs) {
    try {
      sass.compileString(text, { logger: sass.Logger.silent });
    } catch (error) {
      throw new Error(`Dart Sass rejected ${id}: ${error.message}`, { cause: error });
    }
  }
  return { implementation: sass.info, inputs: inputs.length };
}

module.exports = { validInputs, validEdits, checkSass };
