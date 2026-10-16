// Timing uses the runtime allocator; a separate invocation measures retained tree allocations.
#define _POSIX_C_SOURCE 200809L
#include <inttypes.h>
#include <stddef.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>
#include <tree_sitter/api.h>

extern const TSLanguage *tree_sitter_scss(void);
extern const TSLanguage *tree_sitter_stylesheet_css(void);

typedef union {
  max_align_t alignment;
  size_t size;
} Allocation;

static size_t live_bytes;

static void *count_malloc(size_t size) {
  if (size > SIZE_MAX - sizeof(Allocation)) abort();
  Allocation *allocation = malloc(sizeof(Allocation) + size);
  if (!allocation) abort();
  allocation->size = size;
  live_bytes += size;
  return allocation + 1;
}

static void count_free(void *pointer) {
  if (!pointer) return;
  Allocation *allocation = (Allocation *)pointer - 1;
  live_bytes -= allocation->size;
  free(allocation);
}

static void *count_calloc(size_t count, size_t size) {
  if (size && count > SIZE_MAX / size) abort();
  void *pointer = count_malloc(count * size);
  memset(pointer, 0, count * size);
  return pointer;
}

static void *count_realloc(void *pointer, size_t size) {
  if (!pointer) return count_malloc(size);
  if (!size) {
    count_free(pointer);
    return NULL;
  }
  if (size > SIZE_MAX - sizeof(Allocation)) abort();
  Allocation *allocation = (Allocation *)pointer - 1;
  size_t previous = allocation->size;
  allocation = realloc(allocation, sizeof(Allocation) + size);
  if (!allocation) abort();
  allocation->size = size;
  live_bytes = live_bytes - previous + size;
  return allocation + 1;
}

static double milliseconds(void) {
  struct timespec time;
  if (clock_gettime(CLOCK_MONOTONIC, &time)) abort();
  return time.tv_sec * 1000.0 + time.tv_nsec / 1000000.0;
}

static int compare_time(const void *left, const void *right) {
  double a = *(const double *)left, b = *(const double *)right;
  return (a > b) - (a < b);
}

static uint64_t shape(TSTree *tree) {
  uint64_t hash = UINT64_C(14695981039346656037);
  TSTreeCursor cursor = ts_tree_cursor_new(ts_tree_root_node(tree));
  for (;;) {
    TSNode node = ts_tree_cursor_current_node(&cursor);
    uint32_t words[] = {ts_node_symbol(node), ts_node_start_byte(node), ts_node_end_byte(node),
      ts_node_child_count(node), ts_node_is_named(node), ts_node_is_missing(node),
      ts_node_has_error(node), ts_tree_cursor_current_field_id(&cursor)};
    for (size_t index = 0; index < sizeof(words) / sizeof(*words); index++) {
      hash = (hash ^ words[index]) * UINT64_C(1099511628211);
    }
    if (ts_tree_cursor_goto_first_child(&cursor)) continue;
    while (!ts_tree_cursor_goto_next_sibling(&cursor)) {
      if (!ts_tree_cursor_goto_parent(&cursor)) {
        ts_tree_cursor_delete(&cursor);
        return hash;
      }
    }
  }
}

int main(int argc, char **argv) {
  if (argc != 5) return 2;
  char *end;
  long repetitions = strtol(argv[3], &end, 10);
  if (*end || repetitions < 1 || repetitions > 10000) return 2;
  bool memory = strcmp(argv[4], "memory") == 0;
  if (!memory && strcmp(argv[4], "time")) return 2;
  if (strcmp(argv[1], "scss") && strcmp(argv[1], "css")) return 2;
  FILE *file = fopen(argv[2], "rb");
  if (!file) { perror(argv[2]); return 2; }
  if (fseek(file, 0, SEEK_END)) return 2;
  long length = ftell(file);
  if (length < 0 || (unsigned long)length > UINT32_MAX) return 2;
  rewind(file);
  char *source = malloc((size_t)length + 1);
  if (!source) return 2;
  if (fread(source, 1, (size_t)length, file) != (size_t)length) return 2;
  fclose(file);
  if (memory) ts_set_allocator(count_malloc, count_calloc, count_realloc, count_free);
  TSParser *parser = ts_parser_new();
  const TSLanguage *language = strcmp(argv[1], "css") ? tree_sitter_scss() : tree_sitter_stylesheet_css();
  if (!ts_parser_set_language(parser, language)) return 2;
  TSTree *tree = ts_parser_parse_string(parser, NULL, source, (uint32_t)length);
  if (!tree) return 2;
  bool has_error = ts_node_has_error(ts_tree_root_node(tree));
  uint64_t hash = shape(tree);
  size_t with_tree = live_bytes;
  ts_tree_delete(tree);
  size_t tree_bytes = with_tree - live_bytes;
  size_t parser_bytes = live_bytes;
  double *samples = malloc((size_t)repetitions * sizeof(double));
  if (!samples) return 2;
  if (!memory) {
    for (long index = -3; index < repetitions; index++) {
      double start = milliseconds();
      tree = ts_parser_parse_string(parser, NULL, source, (uint32_t)length);
      double elapsed = milliseconds() - start;
      if (!tree) return 2;
      if (index >= 0) samples[index] = elapsed;
      ts_tree_delete(tree);
    }
    qsort(samples, (size_t)repetitions, sizeof(double), compare_time);
  }
  printf("{\"hasError\":%s,\"shape\":\"%016" PRIx64 "\",\"treeBytes\":%zu,\"parserBytes\":%zu,\"medianMs\":%.6f,\"minMs\":%.6f}\n",
    has_error ? "true" : "false", hash, tree_bytes, parser_bytes,
    memory ? 0.0 : samples[repetitions / 2], memory ? 0.0 : samples[0]);
  ts_parser_delete(parser);
  free(source);
  free(samples);
  return live_bytes ? 3 : 0;
}
