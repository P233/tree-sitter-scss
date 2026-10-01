# Architecture

This package supplies concrete syntax trees and ordered highlight captures for CSS and SCSS. It is not a Sass evaluator, CSS validator, editor, or document store. The [consumer contract](README.md#consumer-contract) defines the public behavior; this document describes its implementation boundaries.

## Ownership and dependency direction

```text
grammar.js ── generator ── src/parser.c + schema + runtime headers
src/scanner.c ─────────────┘
                            ├── Node binding ── native acceptance tests
queries/highlights.scm ──────┤
                            └── Rust/native binding ── native acceptance tests

scripts/grammar.js ── CLI / native build
        ↑
scripts/preview.js ── fresh inspect.js process + standard CLI highlighting
        ↓
preview-client.js ── temporary browser draft
```

| Boundary                           | Owns                                                                            | Does not own                                                        |
| ---------------------------------- | ------------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| `grammar.js`                       | Syntax structure, fields, precedence, block contexts and external-token order   | Editor completion, semantic evaluation or runtime caches            |
| `src/scanner.c`                    | Lexical context, bounded pairing, dialect identity and CSS lexer adaptation     | Document state, source mutation, history or persisted scanner state |
| Generated `src/` files             | Reproducible projections of the grammar and generator version                   | Independent handwritten decisions                                   |
| `queries/`                         | Portable capture names and their ordered overrides                              | Host colors, fonts or editing commands                              |
| `bindings/node/`, `bindings/rust/` | Native language exports and access to schema/query                              | Build orchestration and preview lifecycle                           |
| `scripts/grammar.js`               | Checkout root, CLI executable/options/cache, generation and native build        | Syntax decisions or preview state                                   |
| `scripts/benchmark.js`             | Sample timing, per-dialect parser/tree lifetime and process resource reporting  | Parser allocation policy, editor latency or document history        |
| `scripts/preview.js`               | HTTP requests, file watching, build invalidation and published preview revision | Durable documents or browser drafts                                 |
| `scripts/preview-client.js`        | Draft text, one active generation request, focus restoration and update notice  | Parser lifecycle or source-file writes                              |

The Tree-sitter runtime owns trees and incremental reuse. A host edits the old tree before reparsing; undo is another host edit. No parser-local history or second source model exists. Native packages include generated C and headers so installing them does not require the generator. Their file lists are checked rather than inferred from repository layout.

## Invariants

- CSS and SCSS share one generated parsing table, node schema and query. Language selection is immutable per entry; it is never a global dialect switch.
- The scanner serializes zero bytes. Every lookahead context belongs to one call and is discarded on return.
- Whitespace before a colon has one external token shared by declarations and selector combinations. The grammar resolves those readings; the scanner does not repeatedly search for a block after each spaced pseudo. Cross-line recovery retains its existing lookahead window.
- A selector line that cannot continue ends with a hidden statement-break token. Selector states never accept it, so recovery returns to the enclosing statement list; statement lists and raw statement items accept it, and the `*` hack has its own line token, so a separator after `*` still ends its line. Selector decisions emit it after whitespace that crosses into a line that starts with a declaration, and at punctuation that ends its line above a declaration without completing the selector, which the token then includes. A statement list claims such punctuation as the same break when no line break comes before it, which also hides the same punctuation after another statement on that line; a token no state accepts there would be reported, but recovery then merges it with the rest of the file. A value emits the break before a whole declaration line, as below. Never emit the break at a compound start, where identifier recovery commonly lands.
- An unfinished at-rule header has a token that no state accepts, so the parser skips the header as one error. The scanner emits it at a statement start, for a block at-rule that nests among declarations, and where an `@if` block may end, for an `@else` header, when the header meets a declaration line, one whose value ends with `;` on that line, before its block opens. Those at-rules are the Sass directives `@if`, `@each`, `@for`, `@while` and `@at-root` as spelled, and `@media`, `@supports`, `@container`, `@layer`, `@scope` and `@starting-style` in any case. The scanner cannot tell the top-level statement list from a block's, and no declaration may follow a header at the top level, so claiming the header of an at-rule usually written there, such as `@mixin` or `@font-face`, would strand its body before the next rule; those keep their own recovery. Inside a group only the header's first line break counts, and only when the group never closes, so a header runs the declaration checks at most twice. Other spellings, other at-rules and an `@else` with no `@if` keep their own recovery too. A declaration value, where `!important` is valid, ends with the statement break before such a line unless a group open around it closes later; an exhausted lookahead budget counts as no group. A `*` hack declaration counts as such a line, although Sass reads a line-leading `*` as multiplication. An unclosed `url(` ends the same way: a Sass payload never holds a declaration, and a CSS one does only when it is exactly `name:` before whitespace. That CSS break includes the `name:` payload rather than ending at the line above, because the payload end is marked before the declaration lookahead so that a payload starting no declaration keeps its own end. Expression positions in general never emit the break: they are also the states inside maps and arguments, where a break damaged recovery far from the edit.
- Interpolation pairing uses the existing 1,024-step budget and 64-step nested-opener charge. Local frame capacity is derived from that budget, including the final opener that exhausts it. There is no independent depth policy, recursive scan, heap growth or frame cleanup path.
- The CSS descriptor is published once with acquire/release synchronization. This protects concurrent native callers and must not be replaced with an unsynchronized flag.
- CSS CRLF normalization preserves original positions in the main lexer. Literal keyword matching shares the generated keyword lexer directly; it has no identifier escapes to normalize. External scans retain their own dialect-aware escape routine.
- `pnpm generate` removes Tree-sitter's optimize-off pragma from `src/parser.c`, and `--check` applies the same step before comparing. The generator adds it for any large lexer, assuming lexing is cheap; here the lexer is about a quarter of parse time, and keeping it optimized cuts corpus CPU time by about 14% and the parser object by about 19%, for several more seconds of compilation. An unrecognized pragma fails generation instead of silently compiling the lexer unoptimized.
- Grammar external-token order and the scanner enum must agree. Generate and test after changing either side; never hand-edit generated C to change syntax.
- Public nodes, fields, anonymous punctuation, ranges, ERROR/MISSING status and ordered captures are compatibility surfaces. “Both parses succeed” is insufficient equivalence evidence.
- All development CLI invocations go through `runTreeSitter`, using `build/tree-sitter` in the current checkout. A same-named grammar compiled elsewhere cannot supply its library.
- Foreground test/parse/highlight commands inherit the terminal and keep the CLI's running lifetime. Internal generation/preview calls capture output with a 30-second timeout and 16 MiB limit. Both modes share the same executable, checkout and cache policy.
- Build-source edits invalidate the preview binding. A fresh inspector process loads the rebuilt native module; source-only edits and browser drafts do not rebuild it. Drafts never overwrite fixtures.

The interpolation budget bounds temporary storage and nested scanning. It does **not** prove that every scan or complete parse is linear: identifier/trivia scans and statement lookahead have separate costs.

## Independent validation

After `pnpm build`, `pnpm test:node` runs native parser/schema/highlight/editing tests without starting the preview server. `pnpm test:development` tests generation, real CLI isolation, HTML generation, browser request state and the HTTP watcher lifecycle. `pnpm test:parser` checks corpus trees and CLI highlighting; `pnpm test:rust` checks the other runtime/binding boundary.

`pnpm test` retains parser, Node and development coverage. `pnpm check` additionally requires lint, formatting, generated-file equality, Rust tests/formatting, package contents and preview export. The generated parser has a 525-large-state budget; it is not a performance score or permission to weaken behavior.

Two-copy CLI tests intentionally compile distinct root-node names under the same grammar name, switch back to the first copy, and check diagnostics for malformed input. Pairing tests characterize the visible threshold and exercise 100,000 nested openers. Runtime tests compare incremental/repair trees and captures rather than relying only on `hasError`.

## Performance measurements

Run `pnpm benchmark` to rebuild and measure the local native binding. For an already built comparison checkout, use:

```sh
node --expose-gc scripts/benchmark.js --repo /path/to/comparison
node --expose-gc scripts/benchmark.js --corpus /path/to/file-list.txt
```

The optional corpus is a newline-separated list of file paths, resolved from the invoking directory; every file is parsed through both language entries. Output records runtime/platform, source and workload hashes, native/parser size, state counts, module load time, process peak RSS, and parse/edit latency. Rebuild each comparison checkout first. Source hashes identify inputs; they do not certify a stale native binary.

Full-parse samples have two warmups and nine measured rounds. Before every full-parse round and incremental sample, the runner requests GC when available and yields one event-loop turn so queued native finalizers can run; both steps are outside the timed region. Small/nested samples are batches of 1,000 parses. Incremental samples change one numeric value in a 1,000-rule file and include 20 warmups followed by 200 measured edits. Each dialect owns its parser and last incremental tree in one async scope, followed by the same cleanup before the next dialect and final resource report. These measure parser work, not GUI latency. `maxRssKiB` is the process peak, while `processRssAfterCleanupBytes` is process RSS after the final cleanup; both include the runtime and benchmark, not just parser storage. `gcBetweenParseSamples` records whether GC was exposed; without it, collection remains automatic.

Without the event-loop yield, native finalizers stay queued even after `gc()`, and discarded trees inflate peak RSS by more than an order of magnitude (about 1.5 GB against 86 MB on Node 24.21.0 / Tree-sitter 0.25.1). The cleanup corrects measurement-induced retention; it does not reduce a live tree's allocation. Because GC and yielding also change heap and cache conditions, compare revisions only with this runner, never against results from a runner without the cleanup.

The spaced-pseudo and multiline-pseudo workloads each contain 20,000 pseudos. They protect the distinction between local token recognition and repeated scanning of the remaining selector. The long-comment-lines workload ends 128 selector lines with a 1 MB comment, which cross-line lookahead must not read in full from every line; comments spend the same step budget as other characters. Native acceptance tests also check the complete selector and following rule, without a machine-dependent timing assertion.

Alternate baseline/candidate order on the same machine with identical hashes. Investigate a repeatable regression in a representative workload before accepting a change. Do not turn one noisy wall-clock result into a CI threshold or claim a speedup from generated size alone.

The 2026-09-30 bounded-storage refactor kept 1,987 states, 478 large states and the 3,961,896-byte parser unchanged. On an Apple M1 Pro, Node 24.21.0 and runtime 0.25.1, same-process alternating measurements gave:

| Workload, median ms                     | SCSS before | SCSS after | CSS before | CSS after |
| --------------------------------------- | ----------: | ---------: | ---------: | --------: |
| 72,918-byte stress fixture              |       4.769 |      4.748 |      5.267 |     5.261 |
| 100 rules                               |       1.098 |      1.096 |      1.126 |     1.124 |
| 1,000 rules                             |      11.058 |     11.076 |     11.121 |    11.171 |
| Numeric edit in 1,000 rules             |       0.239 |      0.240 |      0.240 |     0.240 |
| 10,000 unfinished interpolation openers |      17.547 |     16.672 |      9.062 |     9.079 |

Independent native C measurements over 338 local files / 945,278 bytes were SCSS 76.87 → 76.98 ms and CSS 32.51 → 32.57 ms (seven alternating groups, best of ten within each group, median across groups). Ordinary parsing and editing were effectively unchanged; the measured unfinished-SCSS workload improved about 5%. Initial separate-process Node groups were noisy and are not evidence of a general improvement. The direct resource result is narrower: the scanner no longer references `malloc`, `realloc` or `free`; it uses 16 local frames, 192 bytes on this ABI. No process-wide memory reduction is claimed.

The later Q017 comparison uses clean v0.10.0 as its baseline and identical `-O2` native builds. On the same machine/runtime, seven alternating corpus groups (best of ten within each group, median across groups) and three alternating pseudo-chain samples gave:

| Workload, median ms                         | SCSS before | SCSS after | CSS before | CSS after |
| ------------------------------------------- | ----------: | ---------: | ---------: | --------: |
| 338 local files, selected by file extension |       76.24 |      76.40 |      32.27 |     32.52 |
| 20,000 spaced pseudos                       |    4,698.55 |      34.12 |   4,691.11 |     33.48 |
| 20,000 pseudos on separate lines            |    4,815.52 |     197.40 |   4,813.78 |    196.88 |

Ordinary corpus parsing was effectively unchanged. The targeted improvement removes repeated scanning; it is not a general parser speedup. The tradeoff is 1,997 → 2,066 states, 454 → 465 large states and 3,983,147 → 4,092,269 bytes of generated C. The node schema remains unchanged. Electric-pairing probes retained the baseline 536/570 and 512/570 keystrokes, so this change does not resolve Q016.

## Decisions and remaining debt

The architecture review considered retaining shared tables with simpler resource/execution ownership, pre-classifying statements in the scanner, and generating separate dialect tables. The first option preserves the smallest supported model. The statement-classification prototype changes incomplete-tree recovery and has failing acceptance evidence; separate dialect tables add generation/schema obligations without demonstrated net benefit. Neither is part of this migration.

The combined performance/memory review also rejected inlining the tested hidden selector/raw productions, imposing a hard character cap on recovery lookahead, and replacing ordered query captures with sorted matches: each changed existing trees or editing-time capture order. Hidden productions and long trivia carry recovery obligations even when they are absent from the public tree. The full highlight query also has a pathological ordered-cursor cost with thousands of intervening comments; changing query execution belongs to the host/runtime and needs its own ordering proof.

Follow-up recovery experiments confirmed that adding a never-emitted missing-block token alone does not fix Q016. In the inspected Tree-sitter 0.25.1 runtime, temporary recovery branches can reach their version limit before retaining the required reduction. Inlining selector-list/complex-selector dispatchers improves some incomplete heads but loses existing selector and function captures elsewhere. A zero-width boundary before a prospective property name also competes with keyword scanning for the lexer's single token-end mark. These experiments do not justify removing cross-line block lookahead or changing runtime limits.

A raw-identifier leaf prototype reduced hidden storage in a synthetic 1 MB value, but broader editing tests exposed a following block closer being captured as interpolation punctuation. It was rejected. Common-case allocation savings and unchanged valid trees are insufficient when damaged input loses existing highlighting. Recovery acceptance tests retain useful roles in unfinished selectors, function heads and nth formulas without freezing their entire erroneous CST.

Retain the fresh-process preview boundary, standard CLI HTML renderer, CSS adapter, atomic descriptor publication, context-specific grammar productions and required generated headers. Replacing them would need new contract/performance evidence. Repository file moves and a metadata generator do not remove a demonstrated obligation here.

The subsequent Q017 change removes the unbounded per-pseudo block search with one additional external token and no persistent scanner state. It also corrects a previously hidden descendant inside blockless selectors: `@extend :is(.b :hover)` now contains a `complex_selector` for `.b :hover`. Public node types remain unchanged. This is an intentional tree correction, not evidence that every previously accepted tree is byte-for-byte identical.

Tree-sitter recovers by returning to the first earlier state that accepts the current lookahead, then lexes again from the end of the last node it kept. The statement break relies on this. Only a declaration on the next line ends a selector line at whitespace; anything else continues the statement as a descendant, because a break before `}`, the end of input or another selector line leaves two adjacent errors that recovery can merge with the rest of the file. A break at trailing punctuation must include it, because the runtime ignores an empty external token until parsing has advanced past an earlier error, and reusing a recovered subtree changes when that happens, so an incremental parse would differ from a fresh one. The recovered list lexes that punctuation again, so it claims the punctuation as a break when no line break comes before it; otherwise the second error merges with the rest of the file, as it did for selectors of several compounds. A stray separator at the start of its own line therefore remains an error. A break decided across a line, at a selector or a value, ends at the end of the line above and leaves the whitespace to the next token. An error that then reaches into the next line pays for the line break, so recovery reports the unfinished line rather than the start of the declaration below it, and a value that ends with a dotted name, which takes no missing `;`, becomes one error. A value that ends with interpolation instead lets the next declaration's name join the error; over typed values and random edits the placement still recovers more declarations than a break at the start of the next line. These breaks are therefore empty in the runtime's sense, which the trailing-punctuation argument above warns about. They stay consistent because the token before each one, a selector, a value or a header, has width, so parsing has advanced past any earlier error; a break right after a missing token or at an earlier error could be dropped in one parse and kept in the other. The declaration colon stays an internal token; lexing it externally removes forks at declarations but more than halves incremental reuse speed.

A stray block recovers as a missing selector or as a bare `@media` at equal cost, and the runtime then keeps whichever version it reached first, which differs between incremental and fresh parses. Dynamic precedence on the bare `@media` form makes the missing selector win in both; that form has no competing valid parse. An unfinished `*` hack such as `*zoom rhythm(90);` ties the same way between a declaration and a universal selector that swallows the next rule's selector; a `*` touching a plain name can only be the hack, so dynamic precedence on a touching `*` keeps the declaration reading. A touching `#{` lexes as the adjacent interpolation of a selector, which the property name does not accept, so `*#{$p}` never reaches this choice. A `*` that a line separates from its name gets no precedence, which would otherwise merge a stray `*;` line with the declaration below it.

Known baseline debt remains. A header whose group stays open past its first line can still absorb the following statements, and so can a top-level-style at-rule such as `@mixin` typed inside a rule above a declaration; a top-level `@media` header cut off by a declaration line leaves that declaration to the next rule's selector; lookahead loops skip each interpolation with a 1,024-step budget of its own, so one header scan full of long interpolations can take about a million steps; a missing semicolon after a value that ends with interpolation, an unclosed `url(`, and an interpolated name typed on its own line above a declaration each put the next declaration's name in an `ERROR`; and punctuation after another statement on the same line above a declaration is not reported (Q016). An unclosed `#{` with more text after it on its line pairs with a later `}`. An interpolation that continues a name, as in `&#{$p}(.x)` or `.a#{$p}(.b)`, still cannot take selector arguments: the name claims it before the `(` that would make it a pseudo call.

For future changes: establish the required behavior, identify its owner, challenge any new state or cross-layer classification, add contract evidence, implement, and measure affected hot paths. Remove replaced mechanisms rather than keeping an indefinite parallel path. Stop when remaining alternatives have no demonstrated benefit.
