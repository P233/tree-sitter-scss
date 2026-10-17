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
    "font-size: clamp(1rem, 2vw + 1rem, 3rem);"
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
  "&-x:"
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

module.exports = {
  contractStatements,
  contractBefore,
  contractLayouts,
  typingStatements,
  blockStatements,
  headers,
  unfinishedLines,
  unfinishedHeaders,
  typos
};
