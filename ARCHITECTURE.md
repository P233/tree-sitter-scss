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
| `scripts/preview.js`               | HTTP requests, file watching, build invalidation and published preview revision | Durable documents or browser drafts                                 |
| `scripts/preview-client.js`        | Draft text, one active generation request, focus restoration and update notice  | Parser lifecycle or source-file writes                              |

The Tree-sitter runtime owns trees and incremental reuse. A host edits the old tree before reparsing; undo is another host edit. No parser-local history or second source model exists. Native packages include generated C and headers so installing them does not require the generator. Their file lists are checked rather than inferred from repository layout.

## Invariants

- CSS and SCSS share one generated parsing table, node schema and query. Language selection is immutable per entry; it is never a global dialect switch.
- The scanner serializes zero bytes. Every lookahead context belongs to one call and is discarded on return.
- Interpolation pairing uses the existing 1,024-step budget and 64-step nested-opener charge. Local frame capacity is derived from that budget, including the final opener that exhausts it. There is no independent depth policy, recursive scan, heap growth or frame cleanup path.
- The CSS descriptor is published once with acquire/release synchronization. This protects concurrent native callers and must not be replaced with an unsynchronized flag.
- CSS CRLF normalization preserves original positions. The adapter is required for the dialect contract, not a removable compatibility shim.
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

Full-parse samples have two warmups and nine measured rounds, with GC outside each round when available. Small/nested samples are batches of 1,000 parses. Incremental samples change one numeric value in a 1,000-rule file and include 20 warmups followed by 200 measured edits. These measure parser work, not GUI latency. Peak RSS includes the runtime, trees and benchmark; it is not scanner memory usage.

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

## Decisions and remaining debt

The architecture review considered retaining shared tables with simpler resource/execution ownership, pre-classifying statements in the scanner, and generating separate dialect tables. The first option preserves the smallest supported model. The statement-classification prototype changes incomplete-tree recovery and has failing acceptance evidence; separate dialect tables add generation/schema obligations without demonstrated net benefit. Neither is part of this migration.

Retain the fresh-process preview boundary, standard CLI HTML renderer, CSS adapter, atomic descriptor publication, context-specific grammar productions and required generated headers. Replacing them would need new contract/performance evidence. Repository file moves and a metadata generator do not remove a demonstrated obligation here.

Known baseline debt remains: CSS keyword reuse can produce an incremental-only ERROR (Q013); a minus after comment trivia can have different fresh/incremental numeric boundaries (Q010); complex unfinished statements can absorb later rules (Q016); spaced-pseudo lookahead can repeat work quadratically (Q017); invalid bare-block recovery can choose different nodes (Q018). These are not newly accepted product behavior or resolved by this storage refactor. The PatternFly interpolation/selector-argument syntax gap also remains separate.

For future changes: establish the required behavior, identify its owner, challenge any new state or cross-layer classification, add contract evidence, implement, and measure affected hot paths. Remove replaced mechanisms rather than keeping an indefinite parallel path. Stop when remaining alternatives have no demonstrated benefit.
