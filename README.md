# tree-sitter-scss

A Tree-sitter parser for SCSS and CSS, written from scratch. The grammar is designed around SCSS; CSS is a second language entry of the same parser, with the same node schema and highlight query. Indented Sass (`.sass`) and Internet Explorer–only syntax are not supported.

This is an independent project, not affiliated with the official [tree-sitter-scss](https://github.com/tree-sitter-grammars/tree-sitter-scss). It was built for [scss2-mode](https://github.com/P233/scss2-mode), which bundles a snapshot of this parser. It is not published to npm or crates.io, where the `tree-sitter-scss` name belongs to the official grammar; see [Use from source](#use-from-source).

The parser targets complete files. Code written with completion, snippets or coding agents is mostly complete, so error recovery is deliberately narrow: a statement being typed usually stays one local `ERROR` and leaves the rules after it intact. Its [cost is measured against the same parser with scanner recovery disabled](ARCHITECTURE.md#recovery-cost). Broader designs were rejected because they grew the parse table past its budget, slowed parsing and edits, or lost declarations elsewhere.

## Compared with the official grammar

The official grammar extends `tree-sitter-css`; this one serves both dialects with one parser, schema, and query. Measured with Tree-sitter CLI 0.27.0, the official grammar at [`5da5ba7`](https://github.com/tree-sitter-grammars/tree-sitter-scss/tree/5da5ba71a558b007b352c505bfcd9095ae337022) fails on common Sass such as `!default`, `@use ... as`, maps, `@include ns.mixin`, and `$args...`: on the 1,157 non-blank lines of [rhythm-sass `76aac68`](https://github.com/P233/rhythm-sass/tree/76aac6827bdd80d439579f0cf93cad78cd6d7fc7), it reports 700 error nodes, with 37% of the lines inside `ERROR`, where this parser reports none. The official grammar also left-nests selectors, so the `:hover` node in `.a .b:hover` spans the whole selector; has no fields on rules, declarations, or CSS at-rules; reports nested properties as errors; and parses custom-property values as Sass.

Node ranges inside an `ERROR` cannot be trusted, so scss2-mode refuses structural edits there. In exchange, this project owns all CSS compatibility work, and its generated parser is nearly five times larger (3.7 MB of C against 0.76 MB). The schema and query are not interchangeable with the official ones.

The [comparison page](https://peiwen.lu/project/tree-sitter-scss-comparison/) parses the same source in the browser with this grammar, [simeonoff/tree-sitter-scss](https://github.com/simeonoff/tree-sitter-scss/tree/3f918284a73a54b53e4f326b0aa8c74ccbf4ee4d) with the highlight query of Zed’s SCSS & SASS extension, and the official grammar. It shows their highlighting, timings, parse errors and syntax trees side by side. It includes examples, and you can paste your own SCSS.

## Use from source

Both bindings compile the generated C sources, so they need a C/C++ compiler; the Node build also needs Python and Node.js 22.13 or later. Pack a checkout for Node:

```sh
git clone https://github.com/P233/tree-sitter-scss.git
cd tree-sitter-scss && npm pack  # Writes tree-sitter-scss-1.1.0.tgz
```

In a Node project next to the checkout, installing the tarball compiles the binding:

```sh
npm install ../tree-sitter-scss/tree-sitter-scss-1.1.0.tgz tree-sitter@0.25.1
```

```js
const Parser = require("tree-sitter");
const Scss = require("tree-sitter-scss");

const parser = new Parser();
parser.setLanguage(Scss); // Scss.cssLanguage for CSS
const tree = parser.parse(".card { color: $accent; }");
const captures = new Parser.Query(Scss, Scss.HIGHLIGHTS_QUERY).captures(tree.rootNode);
```

In Rust, depend on the checkout by path:

```toml
[dependencies]
tree-sitter = "0.27.0"
tree-sitter-scss = { path = "../tree-sitter-scss" }
```

```rust
let mut parser = tree_sitter::Parser::new();
parser.set_language(&tree_sitter_scss::LANGUAGE.into()).expect("load SCSS"); // CSS_LANGUAGE for CSS
let tree = parser.parse(".card { color: $accent; }", None).unwrap();
```

## Consumer contract

- The `scss` entry (native symbol `tree_sitter_scss`) and the `stylesheet-css` entry (`tree_sitter_stylesheet_css`) share one node schema and one query. Node exports `language`, `cssLanguage`, `nodeTypeInfo`, and `HIGHLIGHTS_QUERY`; Rust exports `LANGUAGE`, `CSS_LANGUAGE`, `NODE_TYPES`, and `HIGHLIGHTS_QUERY`. The parser uses ABI 14 and is tested with Tree-sitter 0.25.1 in Node and 0.27.0 in Rust; `tree-sitter.json` registers only SCSS.
- The CSS entry differs only lexically: for example, `#{` in strings and comments stays literal, and `1px-2px` is one dimension. The CSS entry still parses Sass syntax without errors, and neither entry reports semantic problems such as undefined variables.
- The `value`, `prelude`, and `condition` fields may hold several ordered children, including anonymous commas.
- Declaration values and Sass lists are ordered atoms, with no evaluation tree and no node per comma-separated item; split them on the comma children. Call arguments and maps differ: several atoms in one argument are wrapped in `argument`, and each map pair is a `map_entry`. `-10px` is one number; `-$gutter` is an operator and a variable.
- Structural operators, meaning query and `if()` condition words, feature comparisons and type annotation multipliers, are `operator` nodes whose one anonymous child is named `|` whatever its text, as in `and`, `>=` or `+`; read the operator from the node's text. Sass arithmetic inside a query keeps its own token.
- The `.` child of a `class_selector` is the anonymous `class_dot` token. The selector's `attribute` capture includes it; it has no separate delimiter capture. Module and value dots keep their `.` token.
- A nested property is a `property_declaration` with `name`, optional `value`, optional `body`, and direct braces; there is no `nested_property` node.
- `selector_arguments` holds its parentheses, comma-separated branches, and comments directly, without an inner `selectors` node; value-taking pseudos such as `:lang()` hold value nodes, and the `of` list in `nth_arguments` keeps its own `selectors`. Sass parses a selector after evaluating it, so `#{$sel}(.a)` is a `pseudo_selector` whose `pseudo_name` holds only interpolation. Sass accepts `a, , b` and a trailing comma, so a `,` may be followed by another comma, the block, or `)`.
- The rule, declaration, or directive that owns a block has direct `{` and `}` children that bound the whole interior. The optional `body` only groups content: it can begin or end with a statement comment, and a block that holds only comments still has a `body`. An empty block has no `body`, and an empty declaration has no `value`.
- A `/* */` comment in a statement position is a `block_comment` child; other comments are extras with literal text, and `//` comments never parse interpolation. In SCSS, statement comments and strings parse complete `#{…}` expressions through the grammar, including nested quotes, comments and multiline expressions.
- The shape of an erroneous tree is not part of the contract. A statement typed or mistyped above a declaration usually stays one local `ERROR`, such as an unfinished selector line, a word typed into a declaration (`cur sor: x;`), a cut-off at-rule header or a value missing its `;`. A bare `$` stays inside its statement, and `[a=] {}` parses without an error although Sass rejects it. [Statement breaks](ARCHITECTURE.md#statement-breaks) lists the handled cases.
- Hosts can reparse incrementally from an old tree after edits or agent-applied replacements. On complete supported input, the result has the same tree and ordered captures as a fresh parse, including after damaged input is repaired.
- Keep the parser, [node schema](src/node-types.json), and [highlight query](queries/highlights.scm) on the same revision. Releases follow semantic versioning for entries and capture names: removing or renaming one requires a new major version. A minor release may remove or rename a node type or field, or change a node's children; the release commit and the GitHub release list each such change.

## Highlighting

[queries/highlights.scm](queries/highlights.scm) assigns semantic roles; editors map the captures to their own faces. Most captures are standard Tree-sitter names such as `property`, `variable`, `function`, `module`, and `punctuation.delimiter`; `variable.parameter` marks declared parameters and named call arguments. Outside the Tree-sitter CLI's standard list are `type.unit`, `operator.expression`, and Neovim-style keyword roles: `keyword.import`, `keyword.conditional`, `keyword.repeat`, `keyword.return`, `keyword.debug`, and `keyword.exception` for the Sass directives and clause words they name (others, such as `@mixin`, are plain `keyword`); `keyword.directive` for CSS at-rules and unknown at-keywords; and `keyword.modifier` for `!default`, `!global`, `!optional`, and `!important`.

A later capture of the same range overrides an earlier one, as in the Tree-sitter CLI; the `; Context overrides` section, which refines roles such as map keys, keyframe selectors, and parameters, depends on this. In Emacs, that means `:override t` on the font-lock rules. The query leaves `;`, colons outside pseudo-classes, and brackets other than a type's `<` and `>` uncaptured, so hosts render them in the default face or with their own bracket coloring. Text the parser keeps raw, such as a URL or an unevaluated `$name` in a custom property, is a `string`; a raw fragment of punctuation alone is `punctuation.delimiter`. The query has no error-specific coloring rules. Tree-sitter may still capture zero-width MISSING punctuation; hosts can ignore empty ranges.

## Known limits

- Typed `attr()` unions, as in `attr(data-width type(<length> | <percentage>), 10px)`, are parse errors.
- A value or variable missing its `;` can read a following `$name: …;` line into its value, while a property line ends it.
- A value missing its `;` can also absorb a following custom property whose value holds a literal `//`, such as `--x: https://a.test/x;`.
- A dangling `.` or `!` in a value can absorb the next declaration.
- An incomplete map entry such as `$map: (key:)` can absorb the next declaration. At the top level, incomplete maps can also take following rules.
- A comment before a quoted `url()` argument, as in `url(/* note */ "a.png")`, is a parse error even though Dart Sass accepts it. The deterministic valid-input suite retains these cases as explicit syntax debt.
- In a custom property, `url(https://a.test/x.png)` highlights the scheme apart from the rest of the address.
- While being typed, a block's last selector line can still take the rules after it out of the tree when it is only an interpolation (`#{$sel}`), stops at a pseudo-class colon after a descendant or namespaced compound (`.b .c:`, `svg|a:`) or, without editor pairing, leaves a bracket open (`&:is(`, `&:nth-child(`, `:lang(`, `input[type=`); so can most unfinished selectors in a one-line block such as `.a { color: red; &: }`. Those rules keep their highlighting, though the first one's selector can lose its role.
- Without editor pairing, a call or group left open inside another call or group, including a list or map value, can take the rules after the block out of the tree, as in `width: calc(100% - min(` or `grid-template-columns: repeat(auto-fill, minmax(10rem, 1` on a block's last line. Some such lines, such as `width: calc(100% - min(2rem, 5`, do it even when another declaration follows. Closing them restores the rules. With editor pairing they stay intact.
- Escaped keywords and some selector or value readings differ from Sass; [Sass reading boundaries](ARCHITECTURE.md#sass-reading-boundaries) records the cases, including the deliberate CSS/SCSS difference for CRLF after a hexadecimal escape.
- If no `*/` follows, a value such as `.a { color: red /* note; }` can read `/` and `*` as operators without an error or comment capture. A standalone unfinished block comment does report an error.
- An unclosed `#{` typed into an SCSS string or block comment, as in `"a #{$b c"` or `/* #{$b c */`, can absorb the rules after it; after a block comment they also lose their highlighting.
- In a short file, a last rule left open after a complete declaration (`.a { color: red;` at the end of the file) makes the whole file one `ERROR`; editor bracket pairing prevents it.

## Development

Requires Node.js 24, pnpm, Python, a C/C++ compiler, and a stable Rust toolchain with `rustfmt`.

```sh
pnpm install --frozen-lockfile
pnpm check   # What CI runs: lint, formatting, generated files, build, tests, package contents, preview export
pnpm dev     # Live preview of trees and highlights at http://127.0.0.1:4173
```

`grammar.js` and `src/scanner.c` are the authored sources; `pnpm generate` regenerates everything else under `src/`. After `pnpm build`, `pnpm test:node` runs the native acceptance tests, `pnpm test:valid` enumerates complete statements with whitespace and colon variants, and `pnpm test:fuzz` checks incremental parses after seeded random edits. `pnpm test:recovery` freezes the measured typing boundary with exact per-key counters and no Sass dependency. `pnpm benchmark` measures parsing, highlight queries, incremental edits, and key-by-key typing. See [Architecture](ARCHITECTURE.md) for ownership, invariants, optional Dart Sass validation, and how to compare revisions. `comparison/` holds the comparison page; [its README](comparison/README.md) covers building, previewing and deploying it.

## License

[MIT](LICENSE)
