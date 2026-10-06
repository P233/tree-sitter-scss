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
| `src/scanner.c`                    | Lexical boundaries, statement breaks, dialect identity and CSS lexer adaptation | Document state, source mutation, history or persisted scanner state |
| Generated `src/` files             | Reproducible projections of the grammar and generator version                   | Independent handwritten decisions                                   |
| `queries/`                         | Portable capture names and their ordered overrides                              | Host colors, fonts or editing commands                              |
| `bindings/node/`, `bindings/rust/` | Native language exports and access to schema/query                              | Build orchestration and preview lifecycle                           |
| `scripts/grammar.js`               | Checkout root, CLI executable/options/cache, generation and native build        | Syntax decisions or preview state                                   |
| `scripts/benchmark.js`             | Sample timing, per-dialect parser/tree lifetime and process resource reporting  | Parser allocation policy, editor latency or document history        |
| `scripts/fuzz.js`                  | Seeded random-edit recording and baseline/candidate comparison                  | Parser policy or acceptance decisions beyond its exit rules         |
| `scripts/preview.js`               | HTTP requests, file watching, build invalidation and published preview revision | Durable documents or browser drafts                                 |
| `scripts/preview-client.js`        | Draft text, one active generation request, focus restoration and update notice  | Parser lifecycle or source-file writes                              |

The Tree-sitter runtime owns trees and incremental reuse. A host edits the old tree before reparsing; undo is another host edit. No parser-local history or second source model exists. Native packages include generated C and headers so installing them does not require the generator. Their file lists are checked rather than inferred from repository layout.

## Complete input and statements being typed

The parser targets complete supported CSS/SCSS files. Root statements select rules or directives from their syntax; selector names are identifiers, with no HTML tag registry. Declaration blocks resolve properties at a declaration colon while retaining nested selectors, variables, at-rules and nested properties. Colons inside selectors and groups are not declaration boundaries.

The grammar owns interpolation, balanced groups and CSS `var()` arguments. The scanner recognizes the CSS `var()` name without reading its arguments, and never searches ahead to decide whether an interpolation opener is literal. Its lookahead resolves lexical boundaries (number/unit/subtraction, keywords, priority, namespace prefixes and complete `@if`/`@else` chains) and the statement breaks below. The `IF_END` dependency stays because adding or repairing an else must invalidate reuse of the previous complete if node.

Complete inputs, including those reached by repairing a damaged tree, must retain correct source ranges, structure and ordered highlight captures. Incomplete input is an editing state, not a second language: its tree shape is not a compatibility surface, but its scope is measured. A statement being typed or mistyped should stay one local `ERROR` and leave the following rules intact, because a host otherwise reparses, refontifies and refuses structural edits across the rest of the buffer on every key. Host bundles must import parser, schema and query together; this repository does not update scss2-mode's independent vendor snapshot.

### Statement breaks

A statement break is an external token that selector and value states reject, so recovery returns to the enclosing statement list; statement lists and raw statement items accept it. A cut-off header or a line of leading punctuation instead gets a token no state accepts, so the parser skips that text as one error. Each site decides from the text after it:

| Site                                                                          | Next text                                    | Token                                                                        |
| ----------------------------------------------------------------------------- | -------------------------------------------- | ---------------------------------------------------------------------------- |
| Whitespace in a selector, on its line or across a line break                  | A declaration name                           | Statement break                                                              |
| Punctuation that cannot complete a selector line, and its relex after errors  | A declaration name on the next line          | Statement break including the punctuation                                    |
| `@` with a block at-rule header among declarations, or `@else` after an `@if` | A declaration line before the header's block | Never-valid header token covering the header (and the trivia before `@else`) |
| A later line of a declaration value or of an unclosed Sass `url(`             | A declaration line                           | Statement break at the end of the line above                                 |
| A later-line CSS `url(` payload shaped `name:`                                | The rest of a declaration line               | Statement break including the payload                                        |
| A line-leading `>`, `+`, `~` or `#` in a statement list                       | A declaration name on the next line          | Never-valid header token covering the punctuation                            |

A declaration name may carry dashes or same-line interpolation. A colon touching a name, as in `display:flex`, may instead start a pseudo-class, so such a name counts only when its line ends as a declaration does. A declaration line ends its value with `;` on that line, outside any group still open around it. Inside an open group, a `url(` payload or a header's group, the group must also never close later, and an exhausted budget counts as closing; a header claims such a line only on its first line. Every site skips strings, block comments and same-line interpolation the same way. The claimed headers are `@if`, `@each`, `@for`, `@while` and `@at-root` as spelled, and `@media`, `@supports`, `@container`, `@layer`, `@scope` and `@starting-style` in any case; claiming a header usually written at the top level, such as `@mixin`, would strand its body. A break decided across a line is empty and sits at the end of the line above, so the next line keeps its whitespace; a same-line break includes the whitespace or punctuation it covers. Every helper spends one local budget of 1,024 steps; interpolation in a lookahead must close on its line.

Two grammar tolerances complete the set. A bare `$` lexes as an incomplete variable prefix, and recovery inserts the never-emitted missing name, so the enclosing callable keeps its scope. An attribute operator before its value, as in `[a=]`, parses without an error, although Sass rejects it.

Known gaps remain. A colon typed into a name (`op:acity: 0.4`), an unpaired `[`, and an unclosed `#{` in an SCSS string or comment, which the grammar reads as an expression up to a later `}`, still absorb the following rules. An unclosed `url(` keeps them, but the next declaration's name joins its error, because the call reading wins recovery. Punctuation after another statement or a block's `{` on its line joins a statement break and is not reported; a token no state accepts there would be reported, but recovery then merges it with the rest of the file.

The cross-line search for a spaced colon's block, a line-leading `*` site and text-host interpolation pairing are not sites. None changed the typing counters with editor pairing; pairing helps only where an editor leaves `#{` unclosed, and would reinstate the window that limited complete interpolation. One break for every expression position, which would also end unclosed calls, damages recovery inside maps and arguments.

A new site must reduce the typing counters or the recovery tests' local-error cases, and keep the complete-input fuzz comparison free of error-free differences.

## Invariants

- CSS and SCSS share one generated parsing table, node schema and query. Language selection is immutable per entry.
- The scanner serializes zero bytes and allocates no heap storage. Each lookahead is local to one invocation and bounded by its 1,024-step budget; there is no interpolation stack.
- Whitespace before a colon uses one external token shared by declarations and selector combinations. The grammar resolves the readings. Selector whitespace reads at most the next name to find a declaration colon; it never searches later lines for a block.
- CSS text hosts keep interpolation literal. SCSS statement comments and strings use the ordinary expression grammar, so a quote or `*/` inside a nested expression cannot terminate its outer host prematurely.
- The CSS descriptor is published once with acquire/release synchronization for concurrent native callers.
- CSS CRLF normalization preserves original source positions. The generated keyword lexer has no identifier escapes to normalize; external scans use their dialect-aware escape routine.
- Grammar external-token order and the scanner enum must agree. Generate and test after changing either side; never hand-edit generated C to change syntax.
- `pnpm generate` removes Tree-sitter's optimize-off pragma from the large generated lexer. `--check` performs the same step; unknown pragmas fail rather than silently changing compilation policy.
- Complete-input compatibility includes nodes, fields, anonymous punctuation, ranges and ordered captures. Successful parsing alone is insufficient evidence.
- All development CLI invocations use `runTreeSitter` and the current checkout's `build/tree-sitter` library cache. Same-named grammars in another checkout cannot supply its library.
- Foreground CLI commands inherit the terminal. Internal generation/preview calls capture output with a 30-second timeout and 16 MiB limit.
- Build-source changes invalidate the preview binding. A fresh inspector process loads the rebuilt module; browser drafts do not rebuild it or overwrite source fixtures.

## Independent validation

`pnpm check` runs lint, formatting, generated-file equality, native build, corpus/highlight assertions, Node and development tests, Rust tests/formatting, package contents and preview export. The generated parser retains a 525-large-state budget; source size and state counts do not substitute for performance measurements.

Native tests cover complete syntax and highlight roles, source ranges, dialect boundaries, incremental context changes, and repair back to complete input. Resource smoke tests parse deeply nested or damaged input in a subprocess with a timeout, without requiring a particular erroneous tree. `recovery_test.js` checks each statement-break site, same-line typos and unfinished variables by the error text and the intact later rules, not by the whole erroneous tree, and keeps the known gaps visible.

`pnpm test:fuzz` replays 5,000 seeded single edits per language entry over the fixtures and corpus. Each case compares fresh and incremental trees **and ordered captures**, then reverses the edit and compares with the original. Differences fail only when the expected fresh/original input is error-free; error-input differences are reported. Development tests include a shorter run.

For baseline/candidate comparison, rebuild each checkout and use the same runner, seed, case count and optional corpus file list. Inputs come from the invoking checkout:

```sh
node scripts/fuzz.js record --repo /path/to/baseline --corpus /path/to/file-list.txt --out base.jsonl
node scripts/fuzz.js record --corpus /path/to/file-list.txt --out candidate.jsonl
node scripts/fuzz.js compare base.jsonl candidate.jsonl
```

Comparison rejects misaligned or malformed recordings. It fails on baseline error-free tree changes, ordered capture changes even when trees agree, or candidate incremental/repair failures on error-free input. Error-input tree and capture differences are informational, with no remote-loss gate. A baseline may accept malformed syntax under an older tolerance: such differences still require inspection against the complete-input contract rather than treating its `hasError` flag as a language validator. Removing a tolerance does not authorize unexplained changes to valid syntax.

## Performance measurements

Run `pnpm benchmark` to rebuild and measure the native binding. For already built checkouts:

```sh
node --expose-gc scripts/benchmark.js --repo /path/to/baseline
node --expose-gc scripts/benchmark.js --corpus /path/to/file-list.txt
```

The optional corpus is a newline-separated file list. Every input is exercised in both language entries; `errorFiles` identifies workloads that are not wholly accepted in a dialect. Compare ordinary reading performance only on supported, error-free workloads.

The runner compiles the highlight query once per language and reports its cost separately. Full-file rounds time parsing, ordered `Query.captures`, and their combined elapsed time. They have two warmups and nine measured rounds, batching small/nested workloads 1,000 times. A numeric replacement in a 1,000-rule file separately measures incremental parsing, with 20 warmups and 200 samples. Two typing workloads type 29 statements key by key, with editor-style pairing of `{`, `(`, `[` and `"`, into a fresh parse of another 1,000-rule file: on a blank line above `width: 1px;` and before that declaration on its own line. Every key is timed; `changedKB`, `keysChangingQuarterFile` and `errorKeys` are deterministic and compare exactly between revisions. The interpolated-values workload alternates 500 declarations missing their semicolon with 900-character interpolations, so value lookahead must charge interpolation to its budget.

Before samples, the runner requests GC when exposed and yields to let queued native finalizers run. Cleanup and validation are outside timing. Each dialect releases its final parser/tree before the final resource report. `maxRssKiB` and `processRssAfterCleanupBytes` include the runtime and harness; they are not live tree allocation sizes. Hashes identify sources, query and workloads, but do not certify a stale binary: rebuild both revisions before comparison.

Alternate baseline/candidate order on the same machine and compare repeated runs with matching runtime and workload hashes. Spaced/multiline pseudo chains and long comments retain coverage against repeated scanning of the remaining source. Report parsing separately from capture-query time; neither includes host font-lock, layout, repaint or GUI latency. Generated size alone is not evidence of a speedup.

### 2026-10-05 simplification measurements

Against `bd034f2`, the scanner shrank from 1,192 to 593 lines and external tokens from 25 to 20. Authored grammar/scanner/query code fell by 622 lines (27.5%). Generated states changed from 2,071 to 2,051, large states from 458 to 454, C source from 4,101,771 to 3,988,238 bytes, and the native Node binding from 779,792 to 745,152 bytes. Generated-code churn is excluded from authored-line savings.

The following are medians of three process runs per revision, alternating baseline/candidate order on an Apple M1 Pro, Node 24.21.0 and Tree-sitter 0.25.1. Both revisions used the updated benchmark above, independently rebuilt bindings and identical workload hashes. The local corpus contained eight rhythm-sass source, test, example and generated CSS files; it is a small project sample, not a broad industry corpus. Each cell is milliseconds, before → after.

| Workload                   | Entry |            Parse | Parse + captures |
| -------------------------- | ----- | ---------------: | ---------------: |
| 72,918-byte stress fixture | SCSS  |    3.838 → 3.694 |  12.385 → 12.224 |
| 1,000 rules                | SCSS  |    7.863 → 7.780 |  29.558 → 29.569 |
| Eight-file corpus          | SCSS  |    3.538 → 3.356 |  13.203 → 12.986 |
| Eight-file corpus          | CSS   |    3.551 → 3.378 |  12.889 → 12.676 |
| 20,000 multiline pseudos   | SCSS  | 171.328 → 25.596 | 234.435 → 89.479 |
| 20,000 multiline pseudos   | CSS   | 171.330 → 25.890 | 233.826 → 88.948 |

Ordinary complete-file totals are effectively unchanged, with small observed improvements around 0–2%; highlight queries dominate these workloads. Removing repeated cross-line scanning gives the targeted multiline-pseudo workload about 85% less parsing time and 62% less combined time. Numeric incremental replacement stayed effectively unchanged. These are native parsing/query measurements, not GUI or RSS improvements. The SCSS stress fixture has errors under the CSS entry and is excluded from the table's CSS conclusions.

Across 57 unchanged fixture/corpus inputs in both entries, all 111 baseline error-free cases retained identical complete tree structure/ranges and ordered captures. The 10,000-edit seeded run had no error-free incremental or repaired-input mismatch; two differences were confined to damaged input. Native tests also cover complete interpolation beyond the removed lookahead window.

### 2026-10-05 hidden-dispatcher measurements

The second pass inlines ten existing hidden selector, argument, at-rule, value and raw-token helpers. The grammar keeps their definitions for readability, while runtime trees omit their dispatcher nodes. Public nodes, fields, node schema and highlight queries remain unchanged. Inlining exposes conflicts at the containing productions: declared conflicts increase from 19 to 25, grammar source grows by 20 lines, states from 2,051 to 2,064, large states from 454 to 469, and generated C from 3,988,238 to 4,011,967 bytes (0.6%). This pass reduces runtime allocations rather than authored source size.

Against independently rebuilt `60ba1d8`, the same machine, runtime and timing method above produced these medians of three alternating runs. The frozen local corpus contains 335 files (44 CSS, 291 SCSS), totaling 941,050 bytes; both language entries accept every corpus file. It includes related local projects, so it is not an independent or industry-wide sample. Workload, query and scanner hashes matched across all runs.

| Workload                   | Entry |           Parse |  Parse + captures |
| -------------------------- | ----- | --------------: | ----------------: |
| 72,918-byte stress fixture | SCSS  |   3.699 → 3.295 |   12.212 → 11.749 |
| 1,000 rules                | SCSS  |   7.902 → 6.588 |   29.778 → 28.039 |
| 1,000 rules                | CSS   |   8.087 → 6.746 |   30.459 → 28.618 |
| 335-file corpus            | SCSS  | 85.950 → 73.847 | 293.479 → 276.154 |
| 335-file corpus            | CSS   | 86.229 → 78.919 | 290.387 → 286.038 |
| 20,000 multiline pseudos   | SCSS  | 25.746 → 20.619 |   89.438 → 81.867 |
| 20,000 multiline pseudos   | CSS   | 26.269 → 22.103 |   89.893 → 85.134 |

Corpus parsing takes 8.5–14.1% less time, while parsing plus captures takes 1.5–5.9% less. Numeric incremental replacement is effectively unchanged. The full sweep showed a 4.3% CSS long-comment slowdown (10.141 → 10.582 ms). Three further alternating runs focused on large rules and long comments, with 30 measured rounds each, reduced that difference to 0.4% (10.197 → 10.236 ms); the initial slowdown was not reproduced at the same magnitude. These measurements exclude host rendering and GUI latency.

A native probe walks the retained tree with Tree-sitter 0.25.1's internal subtree layout and sums `ts_subtree_alloc_size` for each heap subtree. For the 1,000-rule input, storage falls from 4,456,000 to 3,576,000 bytes (19.7%); for the SCSS stress fixture, 1,396,304 to 1,150,344 bytes (17.6%); for a synthetic 1,000,020-byte raw-value input, 134,002,552 to 90,001,848 bytes (32.8%). This measures retained node storage, excluding allocator overhead, parser workspace and the rest of the process; it is not an RSS reduction claim.

Across 384 fixture/corpus inputs in both entries, all 765 baseline error-free cases retain identical public tree structure, ranges and ordered captures. The aligned 10,000-edit comparison has zero error-free tree/capture differences and no candidate incremental or repaired-input mismatches. Damaged-input tree/capture differences remain informational. The complete repository check also passes.

### 2026-10-05 CSS var argument ownership

The third pass removes `simple_css_var`, which read arguments ahead of the parser to route simple CSS `var()` calls through ordinary function syntax. Every CSS `var()` call now uses the existing CSS fallback grammar; the scanner only recognizes its name. This removes 34 scanner lines, with no new state, token, grammar production or generated table change. The existing test retains its public argument-tree assertions and stops asserting which internal token path produced them. SCSS still uses ordinary call arguments, while CSS still groups everything after the first comma as one fallback.

Against independently rebuilt `5e2a8e2`, three alternating runs on the same environment and frozen 335-file corpus show effectively unchanged ordinary performance. The corpus parse/combined medians are 73.111/273.797 → 73.358/275.319 ms for SCSS and 75.892/276.126 → 76.056/277.604 ms for CSS, differences below 0.6%. No general speedup is claimed.

The same runner with an additional 1,000-rule workload containing three simple `var()` calls per rule measures the affected path directly. CSS parsing falls from 11.410 to 10.750 ms (5.8%) and parsing plus captures from 48.165 to 47.456 ms (1.5%). The unchanged SCSS path moves from 10.629/47.091 to 10.698/47.386 ms. Numeric incremental replacement remains effectively unchanged. Parser, query and workload hashes match between revisions; scanner hashes are stable within each revision.

All 765 baseline error-free fixture/corpus combinations retain identical public trees, ranges and ordered captures. The aligned 10,000-edit comparison has no tree or capture differences, including damaged inputs, and no incremental/repair mismatches. The complete repository check, strict C scanner compilation and ESLint MCP pass. Wallaby has no data for the changed CSS test; native Node tests supply the execution evidence.

### 2026-10-05 statement-break measurements

Against `514a38f`, which still accepted Internet Explorer–only syntax, the scanner grows from 559 to 932 lines and external tokens from 20 to 24. States go from 2,064 to 2,050 (2,030 without that syntax and before the breaks) and large states from 469 to 463. The node schema regains `variable_name`'s recovery-only `$` and `identifier` children; making `variable_name` a leaf again changed corpus parsing by less than the noise. Three alternating runs on the machine, runtime and frozen 335-file corpus above, with both revisions reading the same fixture and matching workload hashes, gave these medians (milliseconds, before → after):

| Workload                         | Entry |         Parse | Parse + captures |
| -------------------------------- | ----- | ------------: | ---------------: |
| 72,408-byte stress fixture       | SCSS  | 3.425 → 3.625 |  11.821 → 12.409 |
| 335-file corpus                  | SCSS  | 77.86 → 80.05 |  286.70 → 289.28 |
| 335-file corpus                  | CSS   | 80.01 → 82.38 |  288.54 → 290.97 |
| 20,000 multiline pseudos         | SCSS  | 22.05 → 23.04 |    85.15 → 87.50 |
| Interpolated values              | SCSS  | 34.29 → 38.69 |    40.04 → 45.20 |
| Typing on a blank line, p95 key  | SCSS  | 1.920 → 0.579 |                — |
| Typing before a declaration, p95 | SCSS  | 1.930 → 1.924 |                — |

Ordinary parsing costs 3–6% more; corpus parsing plus captures costs about 1% more. On the blank line the typing counters fall from 3,238 KB of changed ranges and 65 quarter-file keys to 53 KB and 2, the two keys that open and close a comment; before a declaration on its own line they fall from 2,776 KB and 56 to 2,519 KB and 50. Over 1,000 seeded single-character insertions of letters, digits and spaces into the 692,771-byte concatenation of the corpus's SCSS files, each followed by its revert, edits leaving fewer than half the top-level rules fall from 31 to 0, edits changing more than half the file from 45 to 0, and the p99 reparse from 21.6 to 1.5 ms; the CSS concatenation falls from 36 to 0 such edits. In the 12,000-edit comparison against `514a38f`, every error-free difference comes from an inserted `*` forming a property hack, and the incremental mismatches, all on damaged input, also occur at `514a38f`.

### 2026-10-06 declaration wrapper

A semicolon-ended `property_declaration` expands its body instead of wrapping the hidden `_property` node, saving about 88 bytes of retained tree per declaration. `_property` remains where it is aliased or wrapped: a block's final declaration without a semicolon, `feature_query` and CSS `@function` bodies. States go from 2,050 to 2,085, large states from 463 to 473, generated C from 4,010,439 to 4,067,467 bytes and the native Node binding from 746,000 to 762,528 bytes. With the storage probe above, the retained tree of the corpus's 692,771-byte SCSS concatenation falls from 21,299,632 to 20,151,496 bytes (5.4%) and that of its 248,298-byte CSS concatenation from 9,368,688 to 8,819,480 bytes (5.9%). Two alternating runs of 15 full parses over the frozen corpus gave medians of 79.4 → 77.4 ms for SCSS and 81.8 → 79.4 ms for CSS.

The 335 corpus files, the stress fixture and the 44 corpus test cases all keep identical public trees, ranges and ordered captures in both entries. Typing, probe and seeded insert-and-revert counters are unchanged. The 12,000-edit comparison has no error-free difference; 8 damaged-input recoveries differ, and incremental mismatches match the baseline.

## Retained boundaries and further work

Keep the CSS adapter, atomic descriptor publication, context-specific groups, generated headers, fresh-process preview and standard CLI HTML renderer. They still protect concrete lexical, concurrency or tooling boundaries. Generic flattening of all groups loses distinctions between selectors, call arguments, query conditions and raw CSS.

Complete control-chain grouping and public editor-facing structural wrappers remain after these simplifications. Unlike the inlined hidden dispatchers, they have downstream consumers; removing them requires a coordinated schema/query and host-consumer migration. Coarsening math constants, map keys, query-feature colors or legacy syntax is a separate behavior decision.

Large declaration blocks can still limit incremental reuse because of selector/property ambiguity. The two `query_group` highlight patterns give media and container feature names their property role. Every child step under `query_group` is costly to compile: with Emacs 31.1 `treesit-query-compile`, the whole query takes about 31 ms per language entry, about 21 ms of it for these two patterns, against 52 ms when they also skipped comments around the name. A comment right after `(`, after a sign or beside the feature name therefore drops the role; none of the 335 corpus files or the stress fixture has one there. Further changes need the same capture and compile-time evidence.
