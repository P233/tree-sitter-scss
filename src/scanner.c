#include "tree_sitter/parser.h"

#include <stdatomic.h>
#include <string.h>

enum TokenType {
  LITERAL_DOUBLE_INTERPOLATION,
  LITERAL_SINGLE_INTERPOLATION,
  LITERAL_COMMENT_INTERPOLATION,
  LITERAL_RAW_INTERPOLATION,
  LITERAL_CSS_URL,
  IMPORTANT_BANG,
  SASS_BOOLEAN,
  SASS_NULL,
  SASS_OPERATOR,
  CALCULATION_CONSTANT,
  CSS_VAR_FUNCTION_NAME,
  SCALAR_NUMBER,
  DIMENSION_NUMBER,
  DIMENSION_UNIT,
  DESCENDANT,
  SPACE_BEFORE_COLON,
  SUBTRACTION_MINUS,
  STATEMENT_COMMENT_START,
  IF_END,
  NAMESPACE_PREFIX,
};

// Dialect identity belongs to the immutable language entry, never to a buffer
// switch or shared mutable scanner configuration. Both entries use one set of
// generated parsing tables; lexical dialect differences are resolved here.
static const char css_dialect = 0;
static void *css_scanner_create(void) { return (void *)&css_dialect; }

void *tree_sitter_scss_external_scanner_create(void) { return NULL; }
void tree_sitter_scss_external_scanner_destroy(void *payload) { (void)payload; }
unsigned tree_sitter_scss_external_scanner_serialize(void *payload, char *buffer) {
  (void)payload;
  (void)buffer;
  return 0;
}
void tree_sitter_scss_external_scanner_deserialize(void *payload, const char *buffer, unsigned length) {
  (void)payload;
  (void)buffer;
  (void)length;
}

static bool css_space(int32_t character) {
  return character == ' ' || character == '\t' || character == '\r' || character == '\n' || character == '\f';
}

static bool digit(int32_t character) {
  return character >= '0' && character <= '9';
}

static bool hex_digit(int32_t character) {
  return digit(character) || (character >= 'a' && character <= 'f') || (character >= 'A' && character <= 'F');
}

static bool name_start(int32_t character) {
  return character == '_' || character >= 0x80 ||
         (character >= 'a' && character <= 'z') || (character >= 'A' && character <= 'Z');
}

static bool name_character(int32_t character) {
  return name_start(character) || digit(character) || character == '-';
}

// The caller is on a backslash. CSS preprocessing combines CRLF; Sass keeps
// its existing single-whitespace escape terminator.
static bool scan_escape(TSLexer *lexer, bool css, bool *complex, int32_t *decoded) {
  lexer->advance(lexer, false);
  if (lexer->eof(lexer) || lexer->lookahead == '\r' || lexer->lookahead == '\n' || lexer->lookahead == '\f') {
    return false;
  }
  if (!hex_digit(lexer->lookahead)) {
    if (decoded) *decoded = lexer->lookahead;
    lexer->advance(lexer, false);
    return true;
  }
  int32_t value = 0;
  for (unsigned digits = 0; digits < 6 && hex_digit(lexer->lookahead); digits++) {
    int32_t character = lexer->lookahead;
    value = value * 16 + (digit(character) ? character - '0' :
                         (character >= 'a' ? character - 'a' : character - 'A') + 10);
    lexer->advance(lexer, false);
  }
  if (decoded) *decoded = value;
  if (css_space(lexer->lookahead)) {
    bool carriage_return = lexer->lookahead == '\r';
    lexer->advance(lexer, false);
    if (css && carriage_return && lexer->lookahead == '\n') {
      lexer->advance(lexer, false);
      *complex = true;
    }
  }
  return true;
}

// The DFA handles units without literal hyphens or CSS CRLF escapes. The
// external path owns only those complex boundaries; it retains no scan state.
static bool scan_unit_tail(TSLexer *lexer, bool css, bool mark_end, bool *complex) {
  bool content = false;
  while (name_character(lexer->lookahead) || lexer->lookahead == '\\') {
    if (lexer->lookahead == '\\') {
      if (!scan_escape(lexer, css, complex, NULL)) break;
    } else {
      bool hyphen = lexer->lookahead == '-';
      lexer->advance(lexer, false);
      // Sass treats 1px-2px and 1px-.2px as subtraction, but allows a
      // trailing hyphen and the first hyphen in 1foo--2.
      if (!css && hyphen && (digit(lexer->lookahead) || lexer->lookahead == '.')) break;
      if (hyphen) *complex = true;
    }
    content = true;
    if (mark_end) lexer->mark_end(lexer);
  }
  return content;
}

static bool scan_unit(TSLexer *lexer, bool css, bool mark_end, bool *complex) {
  if (lexer->lookahead == '-') {
    lexer->advance(lexer, false);
    if (!(css && lexer->lookahead == '-') && !name_start(lexer->lookahead) && lexer->lookahead != '\\') return false;
    *complex = true;
  } else if (!name_start(lexer->lookahead) && lexer->lookahead != '\\') {
    return false;
  }
  return scan_unit_tail(lexer, css, mark_end, complex);
}

// The opening `/*` has already been consumed; ignored comments end at the first `*/`.
static bool skip_block_comment(TSLexer *lexer) {
  bool is_after_star = false;
  while (!lexer->eof(lexer)) {
    int32_t character = lexer->lookahead;
    lexer->advance(lexer, false);
    if (is_after_star && character == '/') return true;
    is_after_star = character == '*';
  }
  return false;
}

// Both dialects parse `//` comments as extras, so lookahead skips them too.
static bool skip_trivia(TSLexer *lexer) {
  for (;;) {
    while (css_space(lexer->lookahead)) lexer->advance(lexer, false);
    if (lexer->lookahead != '/') return true;
    lexer->advance(lexer, false);
    if (lexer->lookahead == '/') {
      while (!lexer->eof(lexer) && lexer->lookahead != '\n' && lexer->lookahead != '\r') lexer->advance(lexer, false);
      continue;
    }
    if (lexer->lookahead != '*') return false;
    lexer->advance(lexer, false);
    if (!skip_block_comment(lexer)) return false;
  }
}

// Named extras can intervene before a number reduces and allow subtraction at
// their closing boundary. Record that dependency without including the comments
// in the numeric token, so edits there invalidate a previously reduced value.
static bool scan_number_comments(TSLexer *lexer, bool css) {
  while (css_space(lexer->lookahead)) lexer->advance(lexer, false);
  if (lexer->lookahead != '/') return false;
  lexer->advance(lexer, false);
  if (lexer->lookahead != '*') return false;
  if (!css) {
    lexer->advance(lexer, false);
    if (skip_block_comment(lexer)) skip_trivia(lexer);
  }
  return true;
}

// Scans a number whose leading dot, if any, the caller has consumed.
static bool scan_number_digits(TSLexer *lexer, bool css, bool has_leading_dot) {
  if (!digit(lexer->lookahead)) return false;
  do { lexer->advance(lexer, false); } while (digit(lexer->lookahead));
  lexer->mark_end(lexer);
  if (!has_leading_dot && lexer->lookahead == '.') {
    lexer->advance(lexer, false);
    if (!digit(lexer->lookahead)) return false;
    do { lexer->advance(lexer, false); } while (digit(lexer->lookahead));
    lexer->mark_end(lexer);
  }
  if (lexer->lookahead == 'e' || lexer->lookahead == 'E') {
    lexer->advance(lexer, false);
    int32_t sign = lexer->lookahead;
    if (sign == '+' || sign == '-') lexer->advance(lexer, false);
    if (!digit(lexer->lookahead)) {
      // Without exponent digits, the e starts the unit. A consumed plus,
      // or a Sass minus before a dot, ends that ordinary one-letter unit.
      if (sign == '+' || (!css && sign == '-' && lexer->lookahead == '.')) return false;
      bool complex = sign == '-';
      scan_unit_tail(lexer, css, false, &complex);
      lexer->result_symbol = DIMENSION_NUMBER;
      return (!css && scan_number_comments(lexer, css)) || complex;
    }
    do { lexer->advance(lexer, false); } while (digit(lexer->lookahead));
    lexer->mark_end(lexer);
  }
  // Immediate tokens may still follow named extras. Claim only this scalar
  // boundary so a comment cannot attach a later identifier as its unit.
  if (css_space(lexer->lookahead) || lexer->lookahead == '/') {
    lexer->result_symbol = SCALAR_NUMBER;
    return scan_number_comments(lexer, css);
  }
  bool complex = false;
  lexer->result_symbol = DIMENSION_NUMBER;
  if (!css && lexer->lookahead == '%') {
    lexer->advance(lexer, false);
    return scan_number_comments(lexer, css);
  }
  if (!scan_unit(lexer, css, false, &complex)) return false;
  return (!css && scan_number_comments(lexer, css)) || complex;
}

static bool scan_number(TSLexer *lexer, bool css) {
  bool leading_dot = lexer->lookahead == '.';
  if (leading_dot) lexer->advance(lexer, false);
  return scan_number_digits(lexer, css, leading_dot);
}

// Longest keyword spelling (`important`, `-infinity`) plus its terminator.
enum { KEYWORD_BUFFER = 10 };

// A non-null escaped flag enables CSS decoding; null keeps literal-only callers unchanged.
static bool scan_identifier(TSLexer *lexer, char *value, unsigned length, bool css, bool *escaped) {
  while (name_character(lexer->lookahead) || lexer->lookahead == '\\') {
    int32_t character = lexer->lookahead;
    if (character == '\\') {
      if (!escaped) return false;
      bool complex = false;
      if (!scan_escape(lexer, css, &complex, &character)) return false;
      *escaped = true;
    } else {
      lexer->advance(lexer, false);
    }
    if (character <= 0 || character >= 0x80 || length + 1 >= KEYWORD_BUFFER) return false;
    value[length++] = (char)character;
  }
  value[length] = '\0';
  return length > 0;
}

static void lowercase(char *word) {
  for (; *word; word++) {
    if (*word >= 'A' && *word <= 'Z') *word += 'a' - 'A';
  }
}

// Claim only an identifier followed by one `|`, keeping specialized name tokens out of ordinary selectors.
static bool scan_namespace_prefix(TSLexer *lexer, bool css) {
  if (lexer->lookahead == '-') {
    lexer->advance(lexer, false);
    if (lexer->lookahead == '-') {
      lexer->advance(lexer, false);
    } else if (!name_start(lexer->lookahead) && lexer->lookahead != '\\') {
      return false;
    }
  }
  while (name_character(lexer->lookahead) || lexer->lookahead == '\\') {
    if (lexer->lookahead == '\\') {
      bool complex = false;
      if (!scan_escape(lexer, css, &complex, NULL)) return false;
    } else {
      lexer->advance(lexer, false);
    }
  }
  lexer->mark_end(lexer);
  // As with descendants, only whitespace directly before `|` separates it; a comment there keeps the prefix.
  bool is_after_space = false;
  for (;;) {
    if (css_space(lexer->lookahead)) {
      is_after_space = true;
      lexer->advance(lexer, false);
    } else if (lexer->lookahead == '/') {
      lexer->advance(lexer, false);
      if (lexer->lookahead != '*') return false;
      lexer->advance(lexer, false);
      if (!skip_block_comment(lexer)) return false;
      is_after_space = false;
    } else {
      break;
    }
  }
  if (lexer->lookahead != '|' || is_after_space) return false;
  lexer->advance(lexer, false);
  lexer->result_symbol = NAMESPACE_PREFIX;
  return lexer->lookahead != '|' && lexer->lookahead != '=';
}

static bool scan_else_keyword(TSLexer *lexer) {
  for (const char *word = "@else"; *word; word++) {
    if (lexer->lookahead != *word) return false;
    lexer->advance(lexer, false);
  }
  if (lexer->lookahead == 'i') {
    lexer->advance(lexer, false);
    if (lexer->lookahead != 'f') return false;
    lexer->advance(lexer, false);
  }
  return !name_character(lexer->lookahead) && lexer->lookahead != '\\' && lexer->lookahead != '#';
}

static bool scan_statement_comment_start(TSLexer *lexer) {
  lexer->advance(lexer, false);
  if (lexer->lookahead != '*') return false;
  lexer->advance(lexer, false);
  lexer->mark_end(lexer);
  lexer->result_symbol = STATEMENT_COMMENT_START;
  return true;
}

static bool scan_important_bang(TSLexer *lexer, bool css) {
  lexer->advance(lexer, false);
  lexer->mark_end(lexer);
  if (!skip_trivia(lexer)) return false;
  char name[KEYWORD_BUFFER];
  if (!scan_identifier(lexer, name, 0, css, NULL)) return false;
  lowercase(name);
  if (strcmp(name, "important") != 0 || !skip_trivia(lexer)) return false;
  // A feature query or call argument ends the priority at its closing parenthesis.
  if (lexer->lookahead != ';' && lexer->lookahead != '}' && lexer->lookahead != ')' && !lexer->eof(lexer)) return false;
  lexer->result_symbol = IMPORTANT_BANG;
  return true;
}

// Whitespace before a selector character is a descendant combinator; `:`, `-` and `|` need one more character.
static bool selector_start(int32_t character) {
  return character == '.' || character == '#' || character == '[' || character == '*' || character == '&' ||
         character == '%' || character == '\\' || name_start(character) || digit(character);
}

static bool selector_start_after(TSLexer *lexer) {
  int32_t first = lexer->lookahead;
  lexer->advance(lexer, false);
  int32_t next = lexer->lookahead;
  if (first == '|') return next != '|';
  bool can_start_name = next == '-' || next == '\\' || next == '#' || name_start(next);
  if (first == ':') return can_start_name || next == ':';
  return can_start_name;
}

static bool scan_literal_interpolation(TSLexer *lexer, unsigned token) {
  if (lexer->lookahead != '#') return false;
  lexer->advance(lexer, false);
  if (lexer->lookahead != '{') return false;
  lexer->advance(lexer, false);
  lexer->mark_end(lexer);
  lexer->result_symbol = token;
  return true;
}

// These var() forms have the same argument nodes as an ordinary call. Let the
// internal lexer own them so unchanged calls do not carry external tokens.
// Anything escaped, interpolated, grouped, or multi-token uses the CSS fallback
// grammar instead. Lookahead also invalidates this choice when arguments change.
static bool simple_css_var(TSLexer *lexer) {
  lexer->advance(lexer, false); // Opening parenthesis.
  while (css_space(lexer->lookahead)) lexer->advance(lexer, false);
  if (lexer->lookahead != '-') return false;
  lexer->advance(lexer, false);
  if (lexer->lookahead != '-') return false;
  lexer->advance(lexer, false);
  while (name_character(lexer->lookahead)) lexer->advance(lexer, false);
  while (css_space(lexer->lookahead)) lexer->advance(lexer, false);
  if (lexer->lookahead == ')') return true;
  if (lexer->lookahead != ',') return false;
  lexer->advance(lexer, false);
  while (css_space(lexer->lookahead)) lexer->advance(lexer, false);
  if (lexer->lookahead == '#') {
    lexer->advance(lexer, false);
    unsigned digits = 0;
    while (hex_digit(lexer->lookahead)) {
      lexer->advance(lexer, false);
      digits++;
    }
    if (digits != 3 && digits != 4 && digits != 6 && digits != 8) return false;
  } else if (name_start(lexer->lookahead)) {
    while (name_character(lexer->lookahead)) lexer->advance(lexer, false);
  } else {
    return false;
  }
  while (css_space(lexer->lookahead)) lexer->advance(lexer, false);
  return lexer->lookahead == ')';
}

// `word` holds `length` characters already consumed by the caller.
static bool scan_keyword(TSLexer *lexer, const bool *valid_symbols, bool css, char *word, unsigned length) {
  bool escaped = false;
  if (!scan_identifier(lexer, word, length, css, &escaped)) {
    return false;
  }
  // Interpolation extends the identifier; no keyword may claim its prefix.
  if (lexer->lookahead == '#') return false;
  // Literal names may be Sass functions; word operators still allow grouped operands.
  if (!css && lexer->lookahead == '(' &&
      (strcmp(word, "true") == 0 || strcmp(word, "false") == 0 || strcmp(word, "null") == 0)) return false;
  char folded[KEYWORD_BUFFER];
  memcpy(folded, word, sizeof(folded));
  lowercase(folded);
  unsigned token;
  if (css && valid_symbols[CSS_VAR_FUNCTION_NAME] && lexer->lookahead == '(' && strcmp(folded, "var") == 0) {
    lexer->mark_end(lexer);
    lexer->result_symbol = CSS_VAR_FUNCTION_NAME;
    return !simple_css_var(lexer);
  } else if (!css && !escaped && (strcmp(word, "true") == 0 || strcmp(word, "false") == 0)) {
    token = SASS_BOOLEAN;
  } else if (!css && !escaped && strcmp(word, "null") == 0) {
    token = SASS_NULL;
  } else if (!css && !escaped && (strcmp(word, "not") == 0 || strcmp(word, "and") == 0 || strcmp(word, "or") == 0)) {
    token = SASS_OPERATOR;
  } else {
    // Sass operators can precede a group (not(false)); numeric constants
    // followed by a call or module suffix are ordinary names instead.
    if (lexer->lookahead == '.' || lexer->lookahead == '(') return false;
    if (strcmp(folded, "pi") != 0 && strcmp(folded, "e") != 0 && strcmp(folded, "infinity") != 0 &&
        strcmp(folded, "-infinity") != 0 && strcmp(folded, "nan") != 0) {
      return false;
    }
    token = CALCULATION_CONSTANT;
  }
  if (!valid_symbols[token]) return false;
  lexer->mark_end(lexer);
  lexer->result_symbol = token;
  return true;
}

bool tree_sitter_scss_external_scanner_scan(void *payload, TSLexer *lexer, const bool *valid_symbols) {
  // Recovery enables every external token; it must not choose a host context.
  if (valid_symbols[LITERAL_DOUBLE_INTERPOLATION] && valid_symbols[LITERAL_SINGLE_INTERPOLATION]) return false;
  bool css = payload == &css_dialect;
  if (valid_symbols[IF_END]) {
    // The completed if node owns this dependency, so adding an else invalidates reuse.
    lexer->mark_end(lexer);
    lexer->result_symbol = IF_END;
    return !(skip_trivia(lexer) && scan_else_keyword(lexer));
  }
  // CSS text hosts keep interpolation literal. SCSS always uses the grammar's expression parser.
  // Check before skipping whitespace, which belongs to the host's content.
  int literal_token = valid_symbols[LITERAL_DOUBLE_INTERPOLATION] ? LITERAL_DOUBLE_INTERPOLATION
                      : valid_symbols[LITERAL_SINGLE_INTERPOLATION] ? LITERAL_SINGLE_INTERPOLATION
                      : valid_symbols[LITERAL_COMMENT_INTERPOLATION] ? LITERAL_COMMENT_INTERPOLATION
                                                                     : -1;
  if (literal_token >= 0) return css && scan_literal_interpolation(lexer, literal_token);
  if ((valid_symbols[DESCENDANT] || valid_symbols[SPACE_BEFORE_COLON]) && css_space(lexer->lookahead)) {
    while (css_space(lexer->lookahead)) lexer->advance(lexer, true);
    lexer->mark_end(lexer);
    int32_t first = lexer->lookahead;
    if (first == ':' || valid_symbols[DESCENDANT]) {
      lexer->result_symbol = first == ':' ? SPACE_BEFORE_COLON : DESCENDANT;
      if (first == ':' || first == '-' || first == '|') return selector_start_after(lexer);
      if (selector_start(first)) return true;
    }
  }
  // Only valid right after a number: Sass subtracts on an unspaced minus (`1-1`), CSS keeps a signed number.
  if (!css && valid_symbols[SUBTRACTION_MINUS] && lexer->lookahead == '-') {
    lexer->advance(lexer, false);
    lexer->mark_end(lexer);
    lexer->result_symbol = SUBTRACTION_MINUS;
    if (lexer->lookahead == '$' || lexer->lookahead == '(') return true;
    if (lexer->lookahead == '.') lexer->advance(lexer, false);
    return digit(lexer->lookahead);
  }
  if (valid_symbols[DIMENSION_UNIT]) {
    if (lexer->lookahead == '%') {
      lexer->advance(lexer, false);
      lexer->mark_end(lexer);
      lexer->result_symbol = DIMENSION_UNIT;
      return true;
    }
    bool complex = false;
    lexer->result_symbol = DIMENSION_UNIT;
    return scan_unit(lexer, css, true, &complex);
  }
  while (css_space(lexer->lookahead)) lexer->advance(lexer, true);
  if (valid_symbols[STATEMENT_COMMENT_START] && lexer->lookahead == '/') {
    return scan_statement_comment_start(lexer);
  }
  // Where numbers are also valid, a signed number relies on the internal number lexer.
  if (valid_symbols[NAMESPACE_PREFIX] &&
      (name_start(lexer->lookahead) || lexer->lookahead == '-' || lexer->lookahead == '\\')) {
    return scan_namespace_prefix(lexer, css);
  }
  if (valid_symbols[SCALAR_NUMBER] || valid_symbols[DIMENSION_NUMBER]) {
    if (lexer->lookahead == '-') {
      lexer->advance(lexer, false);
      if (!digit(lexer->lookahead) && lexer->lookahead != '.') {
        char word[KEYWORD_BUFFER] = "-";
        return scan_keyword(lexer, valid_symbols, css, word, 1);
      }
    }
    if (digit(lexer->lookahead) || lexer->lookahead == '.') {
      return scan_number(lexer, css) && valid_symbols[lexer->result_symbol];
    }
  }
  if (valid_symbols[IMPORTANT_BANG] && lexer->lookahead == '!') return scan_important_bang(lexer, css);
  // A CSS fallback can offer both typed values and literal balanced groups.
  if (css && valid_symbols[LITERAL_RAW_INTERPOLATION] && lexer->lookahead == '#') {
    return scan_literal_interpolation(lexer, LITERAL_RAW_INTERPOLATION);
  }
  if ((css && valid_symbols[CSS_VAR_FUNCTION_NAME]) || valid_symbols[CALCULATION_CONSTANT] ||
      (!css && (valid_symbols[SASS_BOOLEAN] || valid_symbols[SASS_NULL] || valid_symbols[SASS_OPERATOR]))) {
    char word[KEYWORD_BUFFER];
    return scan_keyword(lexer, valid_symbols, css, word, 0);
  }
  if (!css || !valid_symbols[LITERAL_CSS_URL]) return false;
  bool content = false;
  while (!lexer->eof(lexer) && !css_space(lexer->lookahead) &&
         lexer->lookahead != '(' && lexer->lookahead != ')' &&
         lexer->lookahead != '"' && lexer->lookahead != '\'' && lexer->lookahead != '\\') {
    lexer->advance(lexer, false);
    content = true;
  }
  lexer->mark_end(lexer);
  lexer->result_symbol = LITERAL_CSS_URL;
  return content;
}

extern const TSLanguage *tree_sitter_scss(void);

// CSS consumes CRLF as one newline, including inside identifier escapes. Feed
// that boundary to the shared generated lexer without rewriting the source or
// changing Sass tokenization. All marks and positions remain in the real input.
typedef struct {
  TSLexer lexer;
  TSLexer *source;
} CssLexer;

static void css_advance(TSLexer *lexer, bool skip) {
  TSLexer *source = ((CssLexer *)lexer)->source;
  bool carriage_return = source->lookahead == '\r';
  source->advance(source, skip);
  if (carriage_return && source->lookahead == '\n') {
    source->advance(source, skip);
  }
  lexer->lookahead = source->lookahead;
}

static void css_mark_end(TSLexer *lexer) {
  TSLexer *source = ((CssLexer *)lexer)->source;
  source->mark_end(source);
}

static bool css_eof(const TSLexer *lexer) {
  const TSLexer *source = ((const CssLexer *)lexer)->source;
  return source->eof(source);
}

static bool css_lex(TSLexer *source, TSStateId state) {
  // Generated lexers use advance, mark_end and eof; external scanners continue
  // using the original lexer and their existing dialect-aware escape routine.
  CssLexer input = {
    .lexer = {
      .lookahead = source->lookahead,
      .result_symbol = source->result_symbol,
      .advance = css_advance,
      .mark_end = css_mark_end,
      .eof = css_eof,
    },
    .source = source,
  };
  bool result = tree_sitter_scss()->lex_fn(&input.lexer, state);
  source->result_symbol = input.lexer.result_symbol;
  return result;
}

#if defined(_WIN32)
#define SCSS_PUBLIC __declspec(dllexport)
#else
#define SCSS_PUBLIC __attribute__((visibility("default")))
#endif

// Publish one descriptor atomically. Every pointer to grammar tables is shared
// with SCSS, and callers cannot change the dialect after choosing an entry.
SCSS_PUBLIC const TSLanguage *tree_sitter_stylesheet_css(void) {
  static TSLanguage language;
  static atomic_uint initialized = 0;
  unsigned expected = 0;
  if (atomic_compare_exchange_strong_explicit(&initialized, &expected, 1,
                                              memory_order_acquire, memory_order_relaxed)) {
    language = *tree_sitter_scss();
    language.name = "stylesheet-css";
    language.lex_fn = css_lex;
    // Literal keyword matching has no escapes; CRLF trivia needs no adapter.
    language.external_scanner.create = css_scanner_create;
    atomic_store_explicit(&initialized, 2, memory_order_release);
  } else {
    while (atomic_load_explicit(&initialized, memory_order_acquire) != 2) {}
  }
  return &language;
}
