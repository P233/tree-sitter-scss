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

Complete inputs, including those reached by repairing a damaged tree, must retain correct source ranges, structure and ordered highlight captures. Incomplete input is an editing state, not a second language: its tree shape is not a compatibility surface, but its scope is measured. A statement being typed or mistyped should stay one local `ERROR` and leave the following rules intact, because a host otherwise reparses, refontifies and refuses structural edits across the rest of the buffer on every key.

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

[Known limits](README.md#known-limits) lists the remaining gaps. An unclosed `url(` loses the next declaration's name because the call reading wins recovery; punctuation after another statement or a `{` joins a statement break unreported, because a never-valid token there would make recovery merge the rest of the file.

The cross-line search for a spaced colon's block, a line-leading `*` site and text-host interpolation pairing are not sites. None changed the typing counters with editor pairing; pairing helps only where an editor leaves `#{` unclosed, and would reinstate the window that limited complete interpolation. One break for every expression position, which would also end unclosed calls, damages recovery inside maps and arguments.

A new site must reduce the typing counters or the recovery tests' local-error cases, and keep the complete-input fuzz comparison free of error-free differences. A break must never be emitted where identifier recovery lands: a compound-start break lost declaration captures in 51 of 40,000 seeded edits, against 5 for the adopted sites.

The breaks cost about 3% of parsing time on the 335-file local corpus and 3–6% across the benchmark workloads (about 1% with captures); in exchange, typing on a blank line above a declaration changes 53 KB of ranges instead of 3,238 KB, and none of 1,000 seeded letter, digit or space insertions into the corpus concatenation reparses more than half the file (45 did without the breaks).

## Grammar and query shape

Hidden helpers that only dispatch are listed in `inline`: they keep grammar names without allocating runtime nodes, which cut retained tree storage by 18–33% at the cost of more declared conflicts and states. A semicolon-ended `property_declaration` expands its body instead of wrapping `_property`, about 88 bytes of retained tree per declaration; `_property` remains only where it is aliased or wrapped: a block's final declaration without `;`, `feature_query` and CSS `@function` bodies. Declaration names and value words rename `_interpolated_identifier` to `property_name` or `plain_value` instead of wrapping it, so a name costs one node instead of two. Every context still shares that one reduction, which defers the property-or-selector and module-or-selector decisions to the token after the name. `tag_selector` keeps its wrapper: its reduction is where the declaration colon forks, so each reading lexes the token after the colon in its own state. A declaration whose value is one atom, 91% of the corpus's, holds the atom directly instead of `_value`, `_space_value` and `_expression_atom`. Precedence 1 picks that reading statically, and it must span from the atom to the end of the declaration: Tree-sitter resets the precedence of a `prec` rule's last step when more steps follow, so precedence on the atom alone never reaches the reduction. A one-child hidden node costs 88 bytes and an inline leaf nothing, so retained memory follows token density rather than file size.

Keep the CSS adapter, atomic descriptor publication, context-specific groups, generated headers, fresh-process preview and standard CLI HTML renderer. They still protect concrete lexical, concurrency or tooling boundaries. Generic flattening of all groups loses distinctions between selectors, call arguments, query conditions and raw CSS.

Complete control-chain grouping and public editor-facing structural wrappers have downstream consumers; removing them requires a coordinated schema/query and host-consumer migration. Coarsening math constants, map keys or query-feature colors is a separate behavior decision.

Large declaration blocks can still limit incremental reuse because of selector/property ambiguity. The two `query_group` highlight patterns give media and container feature names their property role. Every child step under `query_group` is costly to compile: with Emacs 31.1 `treesit-query-compile`, the whole query takes about 33 ms per language entry, about 23 ms of it for these two patterns, against 52 ms when they also skipped comments around the name. A comment right after `(`, after a sign or beside the feature name therefore drops the role; none of the 335 corpus files or the stress fixture has one there. Further changes need the same capture and compile-time evidence.

### Rejected designs

These were measured and rejected; revisit them only with new evidence.

- Lexical disambiguation of the declaration colon, where 99% of GLR forks occur: full parsing 11% faster, but incremental edits 54–68% slower, because node reuse must look up the last external token of every reused subtree.
- Plain inlining of `_interpolated_identifier` or the value-side `_expression_atom` does not converge (20 to 40 or more new conflicts); inlining `_value` raises large states from 463 to 725, over the budget. Selector-side inlining lost recovery highlighting.
- A leaf `property_name`, the name token aliased at declaration sites: the colon decision becomes a shift that `_interpolated_identifier`'s right associativity wins without forking, so `th:first-child { … }` after a declaration became an error, with 15 more conflicts and 30 more large states.
- One shared content rule for all groups: 2,071 → 2,208 states, a node-schema change and 217 of 732 snapshot trees changed.
- Narrowing the CSS `var()` fallback to typed atoms: valid `var(--x,[a;b])` fails and a damaged raw interpolation takes the block's `}`. An ordinary block for CSS `@function`: Dart Sass passes `result:` values through verbatim. Dropping `raw_statement` for unknown at-rules: 2% smaller, but future at-rules would carry `ERROR`.
- Narrowing calculations to Sass calc atoms breaks user-defined `min`, `abs` and `round`. Escaped keywords in the generated lexer: parser.c 3.98 → 9.29 MB and parsing 3–7% slower, for no escape in 499 local files.
- A missing-block token and a zero-width break before a name damaged recovery or conflicted with keyword tokens; per-comment lookahead was quadratic.

## Invariants

- CSS and SCSS share one generated parsing table, node schema and query. Language selection is immutable per entry.
- The scanner serializes zero bytes and allocates no heap storage. Each lookahead is local to one invocation and bounded by its 1,024-step budget; there is no interpolation stack.
- Whitespace before a colon uses one external token shared by declarations and selector combinations. The grammar resolves the readings. Selector whitespace reads at most the next declaration line (its name and colon, and the rest of that line when the colon touches the name); it never searches later lines for a block, which once made 20,000 multiline pseudos parse about seven times slower.
- A block after a colon with no whitespace after it starts a selector whenever one parses, as in Dart Sass; `_nested_property`'s negative dynamic precedence states this. Without it, the two equal-cost readings merge after the block and Tree-sitter keeps whichever version it created first, so unrelated grammar edits flipped `th:first-child { … }` after a declaration into a nested property.
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

Comparison rejects misaligned or malformed recordings. It fails on baseline error-free tree changes, ordered capture changes even when trees agree, or candidate incremental/repair failures on error-free input. Error-input tree and capture differences are informational. A baseline may accept malformed syntax under an older tolerance: such differences still require inspection against the complete-input contract rather than treating its `hasError` flag as a language validator. Removing a tolerance does not authorize unexplained changes to valid syntax.

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
