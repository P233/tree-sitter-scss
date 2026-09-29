# tree-sitter-scss

**This project is not affiliated with the official [tree-sitter-grammars/tree-sitter-scss](https://github.com/tree-sitter-grammars/tree-sitter-scss).** It is a Tree-sitter parser written from scratch for both SCSS and CSS: the grammar is designed around SCSS, and CSS support comes automatically from a second language entry of the same parser. Indented Sass (`.sass`) is not supported.

## Why it exists

The parser is built to give two Emacs packages a syntax tree they can act on:

- **Structural editing in [scss2-mode](https://github.com/P233/scss2-mode).** Kill, copy, duplicate, empty, and substitute whole selector branches, declarations, values, arguments, and blocks, following the approach of [JSX Jedi](https://github.com/P233/jsx-jedi) for JSX/TSX. Every editing target is a node or field with exact source boundaries, in CSS and SCSS alike.
- **Context-aware completion with [emmet2-mode](https://github.com/P233/emmet2-mode).** The syntax role at point decides what to offer: at-rules after `@`, properties at the start of a declaration, values after the colon, custom properties inside `var()`, and Sass variables, mixins, and module members. It also decides where an Emmet abbreviation such as `m10` may expand into `margin: 10px;`.

Emacs users should install scss2-mode, which bundles this parser. This repository contains only the grammar, scanner, highlight query, and Node/Rust bindings. It is not published to npm or crates.io, where `tree-sitter-scss` is the official grammar; use a Git checkout or release tag instead.

## Compared with the official grammar

The official grammar extends `tree-sitter-css` with SCSS rules and targets highlighting. This project is one grammar for both dialects, shaped for structural editing and context-aware completion. Measured with Tree-sitter CLI 0.27.0 against the official grammar at commit [`2ef6d42`](https://github.com/tree-sitter-grammars/tree-sitter-scss/tree/2ef6d42e3ad7a8208900f9346f4529806ae0f9f9):

|                   | This project                                                                          | Official                                                                   |
| ----------------- | ------------------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| CSS               | Second entry of the same parser, with the same node schema and query                  | Separate `tree-sitter-css` grammar, whose schema has diverged              |
| Everyday Sass     | Parses cleanly                                                                        | Errors on `!default`, `@use ... as`, maps, `@include ns.mixin`, `$args...` |
| Real code         | [rhythm-sass](https://github.com/P233/rhythm-sass) (1,157 non-blank lines): no errors | 707 error nodes; 37% of non-blank lines fall inside `ERROR`                |
| Empty value       | `color: ;` is a declaration without a value                                           | A zero-width `integer_value`, with no error                                |
| Selectors         | Flat compounds with explicit combinator nodes                                         | Left-nested: the `:hover` node in `.a .b:hover` spans the whole selector   |
| Declarations      | Property, variable, and nested-property nodes                                         | One declaration node; nested properties are errors                         |
| Fields            | `selectors`, `body`, `name`, `value`, `prelude`, `condition`                          | None on rules, declarations, or CSS at-rules                               |
| Custom properties | Raw token payload                                                                     | Parsed as Sass: `0 / 20%` inside `rgb()` becomes a division                |

Coverage matters beyond highlighting: node ranges inside an `ERROR` cannot be trusted, so scss2-mode refuses structural edits there. The costs are owning all CSS compatibility work and a generated parser about five times larger (3.8 MB of C against 0.79 MB). The node schema and highlight query are not interchangeable with the official grammar's.

## Consumer contract

- **Language entries:** `scss` (native symbol `tree_sitter_scss`) and `stylesheet-css` (`tree_sitter_stylesheet_css`). The generated parser uses ABI 14 and is tested with Tree-sitter 0.25.1 in Node and 0.27.0 in Rust. `tree-sitter.json` registers only SCSS; native consumers select the CSS entry explicitly.
- **Bindings:** Node exports `language`, `cssLanguage`, `nodeTypeInfo`, and `HIGHLIGHTS_QUERY`; Rust exports `LANGUAGE`, `CSS_LANGUAGE`, `NODE_TYPES`, and `HIGHLIGHTS_QUERY`. Both entries share one node schema and one query.
- **The CSS entry differs only lexically:** `#{` inside a string stays literal and `1px-2px` is one dimension. Sass syntax in a `.css` file still parses without errors, and neither entry reports semantic problems such as undefined variables.
- **Fields are not always singular:** `value`, `prelude`, and `condition` may hold several ordered children, including anonymous commas. Do not treat the first field child as the whole expression.
- **Values are ordered atoms:** there is no evaluation tree and no node per comma-separated item, so split on the comma children. `-10px` is one number, while `-$gutter` is an operator followed by a variable.
- **Empty forms have no content node:** an empty block has no `body` and an empty declaration has no `value`, so recognize the braces or colon without requiring them.
- **Versioning:** keep the parser, [node schema](src/node-types.json), and [highlight query](queries/highlights.scm) on the same revision. A compatible ABI does not make another grammar's schema or queries interchangeable with these.

## Highlighting

[queries/highlights.scm](queries/highlights.scm) assigns semantic roles; editors map the captures to their own faces. Most captures are standard Tree-sitter names such as `property`, `variable`, `function`, `module`, `string`, and `punctuation.delimiter`; `variable.parameter` marks declared parameters and named call arguments. Keywords carry Neovim-style sub-roles outside the Tree-sitter CLI's standard list:

- `keyword.import`, `keyword.conditional`, `keyword.repeat`, `keyword.return`, `keyword.debug`, and `keyword.exception` for Sass directives and their clause words.
- `keyword.directive` for CSS at-rules and unknown at-keywords.
- `keyword.modifier` for `!default`, `!global`, `!optional`, and `!important`.

When several patterns capture the same range, the later pattern wins. The `; Context overrides` section refines base roles such as map keys, query features, and parameters, so a host highlighter must apply it after the base captures. `ERROR` and `MISSING` nodes are left uncaptured.

## Known limits

None of these appeared in a sample of about 78,000 lines of real CSS and SCSS.

- Escaped keyword spellings are not decoded: `@m\65 dia` becomes a generic at-rule, while `!\69mportant` and `:nth-child(2\6e+1)` produce parse errors. Identifier escapes spanning CRLF are not fully covered.
- Typed `attr()` unions such as `attr(data-width type(<length> | <percentage>), 10px)` produce a parse error.
- A descendant combinator is read from whitespace directly before the next compound, so `.a /* c */.b` is one compound selector. In `@extend`, `.a :hover` reads as `.a:hover`.
- Unspaced subtraction after a call, `fn()-1`, reads as a call followed by `-1`.
- Inside Sass `url()`, `url(map.get($icons, x))` keeps `map.get` as one `function_name` without a `module_name`. Inside raw custom-property values, `url(https://a.test/x.png)` splits into the word `https`, a colon, and the raw text `//a.test/x.png`.
- Editing the innermost of 1,000 nested rules spent about 95 ms in incremental changed-range calculation in a local test.

## Development

Requires Node.js 24, pnpm, Python, a C/C++ compiler, and a stable Rust toolchain with `rustfmt`.

```sh
pnpm install --frozen-lockfile
pnpm check   # Lint, generated-output check, build, parser/Node/Rust tests, package contents
pnpm dev     # Live preview of trees and highlights at http://127.0.0.1:4173
```

`grammar.js` and `src/scanner.c` are the authored sources; `pnpm generate` regenerates everything else under `src/`.

## License

[MIT](LICENSE)
