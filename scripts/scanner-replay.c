#include "tree_sitter/parser.h"
#include <inttypes.h>
#include <stdio.h>
#include <string.h>

// Both variants record callback-visible results, including scans that return false.
typedef struct {
  uint32_t found, symbol, end, position, advances, used_column;
} ScanResult;

#ifndef REPLAY_DRIVER
#include "parser.c"
#include "unicode.h"

const TSLanguage *tree_sitter_stylesheet_css(void);

typedef struct {
  TSLexer lexer;
  const uint8_t *text;
  uint32_t length, start, position, end, width, advances;
  bool is_range_start, used_column;
} ReplayLexer;

static void lookahead(ReplayLexer *lexer) {
  lexer->lexer.lookahead = 0;
  lexer->width = 0;
  if (lexer->position < lexer->length) {
    lexer->width = ts_decode_utf8(lexer->text + lexer->position, lexer->length - lexer->position,
                                  &lexer->lexer.lookahead);
    if (lexer->lexer.lookahead == TS_DECODE_ERROR) lexer->width = 1;
  }
}
static void advance(TSLexer *base, bool skip) {
  (void)skip;
  ReplayLexer *lexer = (ReplayLexer *)base;
  lexer->advances++;
  lexer->position += lexer->width;
  lookahead(lexer);
}
static void mark_end(TSLexer *base) {
  ReplayLexer *lexer = (ReplayLexer *)base;
  lexer->end = lexer->position;
}
static uint32_t get_column(TSLexer *base) {
  ReplayLexer *lexer = (ReplayLexer *)base;
  lexer->used_column = true;
  uint32_t start = lexer->position, column = 0;
  while (start && lexer->text[start - 1] != '\n') start--;
  while (start < lexer->position) {
    int32_t code;
    uint32_t width = ts_decode_utf8(lexer->text + start, lexer->position - start, &code);
    start += code == TS_DECODE_ERROR ? 1 : width;
    column++;
  }
  return column;
}
static bool range_start(const TSLexer *base) {
  const ReplayLexer *lexer = (const ReplayLexer *)base;
  return lexer->is_range_start && lexer->position == lexer->start;
}
static bool eof(const TSLexer *base) {
  const ReplayLexer *lexer = (const ReplayLexer *)base;
  return lexer->position >= lexer->length;
}
static void log_message(const TSLexer *base, const char *format, ...) {
  (void)base;
  (void)format;
}

ScanResult PROBE(const uint8_t *text, uint32_t length, uint32_t offset, unsigned set,
                 unsigned dialect, bool is_range_start) {
  const TSLanguage *language = dialect ? tree_sitter_stylesheet_css() : tree_sitter_scss();
  void *payload = language->external_scanner.create();
  char buffer[TREE_SITTER_SERIALIZATION_BUFFER_SIZE];
  if (language->external_scanner.serialize(payload, buffer) != 0) {
    fputs("Scanner replay requires zero-byte serialization.\n", stderr);
    exit(2);
  }
  bool all[EXTERNAL_TOKEN_COUNT];
  memset(all, true, sizeof(all));
  unsigned rows = sizeof(ts_external_scanner_states) / sizeof(*ts_external_scanner_states);
  const bool *valid = set == rows ? all : ts_external_scanner_states[set];
  ReplayLexer lexer = {
    .lexer = {.advance = advance, .mark_end = mark_end, .get_column = get_column,
              .is_at_included_range_start = range_start, .eof = eof, .log = log_message},
    .text = text, .length = length, .start = offset, .position = offset,
    .end = UINT32_MAX, .is_range_start = is_range_start,
  };
  lookahead(&lexer);
  bool found = language->external_scanner.scan(payload, &lexer.lexer, valid);
  if (language->external_scanner.serialize(payload, buffer) != 0) {
    fputs("Scanner replay requires zero-byte serialization after scanning.\n", stderr);
    exit(2);
  }
  language->external_scanner.destroy(payload);
  return (ScanResult){found, lexer.lexer.result_symbol, lexer.end, lexer.position,
                      lexer.advances, lexer.used_column};
}
#else
ScanResult base_probe(const uint8_t *, uint32_t, uint32_t, unsigned, unsigned, bool);
ScanResult candidate_probe(const uint8_t *, uint32_t, uint32_t, unsigned, unsigned, bool);

static void print_result(ScanResult result) {
  printf("[%" PRIu32 ",%" PRIu32 ",%" PRIu32 ",%" PRIu32 ",%" PRIu32 ",%" PRIu32 "]",
         result.found, result.symbol, result.end, result.position, result.advances, result.used_column);
}

int main(int argc, char **argv) {
  if (argc != 3) {
    fputs("Usage: scanner-replay <packed-inputs> <external-set-count>\n", stderr);
    return 2;
  }
  FILE *input = fopen(argv[1], "rb");
  if (!input) { perror(argv[1]); return 2; }
  unsigned sets = (unsigned)strtoul(argv[2], NULL, 10);
  uint64_t calls = 0, differences = 0;
  uint32_t length, index = 0;
  size_t header;
  while ((header = fread(&length, 1, sizeof(length), input)) == sizeof(length)) {
    uint8_t *text = malloc((size_t)length + 1);
    if (!text) { fputs("Cannot allocate replay input.\n", stderr); return 2; }
    if (fread(text, 1, length, input) != length) {
      fputs("Truncated replay input.\n", stderr); free(text); return 2;
    }
    text[length] = 0;
    for (uint32_t offset = 0; offset <= length; offset++) {
      for (unsigned set = 1; set <= sets; set++) {
        for (unsigned dialect = 0; dialect < 2; dialect++) {
          for (unsigned included = 0; included < 2; included++) {
            ScanResult base = base_probe(text, length, offset, set, dialect, included);
            ScanResult candidate = candidate_probe(text, length, offset, set, dialect, included);
            calls++;
            if (memcmp(&base, &candidate, sizeof(base)) == 0) continue;
            differences++;
            if (differences > 10) continue;
            printf("{\"input\":%u,\"offset\":%u,\"set\":%u,\"dialect\":\"%s\",\"includedRangeStart\":%s,\"base\":",
                   index, offset, set, dialect ? "css" : "scss", included ? "true" : "false");
            print_result(base);
            fputs(",\"candidate\":", stdout);
            print_result(candidate);
            puts("}");
          }
        }
      }
    }
    free(text);
    index++;
  }
  if (header || !feof(input) || ferror(input)) { fputs("Cannot read replay inputs.\n", stderr); return 2; }
  fclose(input);
  printf("{\"inputs\":%u,\"calls\":%" PRIu64 ",\"differences\":%" PRIu64 "}\n", index, calls, differences);
  return differences ? 1 : 0;
}
#endif
