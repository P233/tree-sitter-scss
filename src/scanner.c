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
  SUBTRACTION_MINUS,
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
static bool scan_escape(TSLexer *lexer, bool css, bool *complex) {
  lexer->advance(lexer, false);
  if (lexer->eof(lexer) || lexer->lookahead == '\r' || lexer->lookahead == '\n' || lexer->lookahead == '\f') {
    return false;
  }
  if (!hex_digit(lexer->lookahead)) {
    lexer->advance(lexer, false);
    return true;
  }
  for (unsigned digits = 0; digits < 6 && hex_digit(lexer->lookahead); digits++) lexer->advance(lexer, false);
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
      if (!scan_escape(lexer, css, complex)) break;
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

static bool scan_number(TSLexer *lexer, bool css) {
  bool leading_dot = lexer->lookahead == '.';
  if (leading_dot) lexer->advance(lexer, false);
  if (!digit(lexer->lookahead)) return false;
  do { lexer->advance(lexer, false); } while (digit(lexer->lookahead));
  lexer->mark_end(lexer);
  if (!leading_dot && lexer->lookahead == '.') {
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
      return complex;
    }
    do { lexer->advance(lexer, false); } while (digit(lexer->lookahead));
    lexer->mark_end(lexer);
  }
  // Immediate tokens may still follow named extras. Claim only this scalar
  // boundary so a comment cannot attach a later identifier as its unit.
  if (css_space(lexer->lookahead) || lexer->lookahead == '/') {
    while (css_space(lexer->lookahead)) lexer->advance(lexer, false);
    if (lexer->lookahead != '/') return false;
    lexer->advance(lexer, false);
    lexer->result_symbol = SCALAR_NUMBER;
    return lexer->lookahead == '*';
  }
  bool complex = false;
  lexer->result_symbol = DIMENSION_NUMBER;
  return scan_unit(lexer, css, false, &complex) && complex;
}

// Longest keyword spelling (`important`, `-infinity`) plus its terminator.
enum { KEYWORD_BUFFER = 10 };

// Keywords match literal ASCII spellings only, so a backslash makes the name an ordinary identifier.
static bool scan_identifier(TSLexer *lexer, char *value, unsigned length) {
  while (name_character(lexer->lookahead)) {
    if (lexer->lookahead >= 0x80 || length + 1 >= KEYWORD_BUFFER) return false;
    value[length++] = (char)lexer->lookahead;
    lexer->advance(lexer, false);
  }
  value[length] = '\0';
  return length > 0 && lexer->lookahead != '\\';
}

static void lowercase(char *word) {
  for (; *word; word++) {
    if (*word >= 'A' && *word <= 'Z') *word += 'a' - 'A';
  }
}

// Both dialects parse `//` comments as extras, so priority lookahead skips them too.
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
    bool star = false;
    for (;;) {
      if (lexer->eof(lexer)) return false;
      int32_t character = lexer->lookahead;
      lexer->advance(lexer, false);
      if (star && character == '/') break;
      star = character == '*';
    }
  }
}

static bool scan_important_bang(TSLexer *lexer) {
  lexer->advance(lexer, false);
  lexer->mark_end(lexer);
  if (!skip_trivia(lexer)) return false;
  char name[KEYWORD_BUFFER];
  if (!scan_identifier(lexer, name, 0)) return false;
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

// The caller is on an interpolation's opening brace. Quotes and comments own
// their delimiters; nested Sass interpolation temporarily leaves its string.
static void skip_interpolation(TSLexer *lexer, bool css) {
  lexer->advance(lexer, false);
  unsigned depth = 1;
  int32_t quote = 0;
  while (depth && !lexer->eof(lexer)) {
    if (!quote && (name_character(lexer->lookahead) || lexer->lookahead == '\\' ||
                   lexer->lookahead == '$' || lexer->lookahead == '.')) {
      char name[KEYWORD_BUFFER];
      bool literal_name = scan_identifier(lexer, name, 0);
      bool complex = false;
      // Consume the rest of a qualified, escaped, or long name without
      // recognizing a trailing `url` as a separate literal call.
      while (name_character(lexer->lookahead) || lexer->lookahead == '\\' ||
             lexer->lookahead == '$' || lexer->lookahead == '.') {
        literal_name = false;
        if (lexer->lookahead == '\\') {
          if (!scan_escape(lexer, css, &complex)) break;
        } else {
          lexer->advance(lexer, false);
        }
      }
      if (literal_name) {
        lowercase(name);
        if (strcmp(name, "url") == 0 && lexer->lookahead == '(') {
          lexer->advance(lexer, false);
          while (css_space(lexer->lookahead)) lexer->advance(lexer, false);
          // Strings, Sass variables, and nested calls use ordinary expression
          // trivia. An unquoted URL instead owns its slashes and braces.
          if (lexer->lookahead != '"' && lexer->lookahead != '\'' && (css || lexer->lookahead != '$')) {
            while (!lexer->eof(lexer) && lexer->lookahead != '(' && lexer->lookahead != ')') {
              int32_t character = lexer->lookahead;
              lexer->advance(lexer, false);
              if (character == '\\') {
                if (!lexer->eof(lexer)) lexer->advance(lexer, false);
              } else if (!css && character == '#' && lexer->lookahead == '{') {
                skip_interpolation(lexer, css);
              }
            }
            if (lexer->lookahead == ')') lexer->advance(lexer, false);
          }
        }
      }
      continue;
    }
    if (!quote && lexer->lookahead == '/') {
      skip_trivia(lexer);
      continue;
    }
    int32_t character = lexer->lookahead;
    lexer->advance(lexer, false);
    if (character == '\\') {
      if (!lexer->eof(lexer)) lexer->advance(lexer, false);
    } else if (character == '#' && lexer->lookahead == '{' && (!quote || !css)) {
      skip_interpolation(lexer, css);
    } else if (quote) {
      if (character == quote) quote = 0;
    } else if (character == '"' || character == '\'') {
      quote = character;
    } else if (character == '{') {
      depth++;
    } else if (character == '}') {
      depth--;
    }
  }
}

// A spaced pseudo-class is a selector (`a :hover {`) only if a block opens before the statement ends (`color :red;`).
static bool block_follows(TSLexer *lexer, bool css) {
  int32_t quote = 0;
  while (!lexer->eof(lexer)) {
    if (!quote && lexer->lookahead == '/') {
      skip_trivia(lexer);
      continue;
    }
    int32_t character = lexer->lookahead;
    lexer->advance(lexer, false);
    if (character == '\\') {
      if (!lexer->eof(lexer)) lexer->advance(lexer, false);
    } else if (character == '#' && lexer->lookahead == '{' && (!quote || !css)) {
      skip_interpolation(lexer, css);
    } else if (quote) {
      if (character == quote) quote = 0;
    } else if (character == '"' || character == '\'') {
      quote = character;
    } else if (character == '{') {
      return true;
    } else if (character == ';' || character == '}') {
      return false;
    }
  }
  return false;
}

static bool selector_start_after(TSLexer *lexer, bool css) {
  int32_t first = lexer->lookahead;
  lexer->advance(lexer, false);
  int32_t next = lexer->lookahead;
  if (first == '|') return next != '|';
  bool can_start_name = next == '-' || next == '\\' || next == '#' || name_start(next);
  if (first == ':') return (can_start_name || next == ':') && block_follows(lexer, css);
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
  if (!scan_identifier(lexer, word, length)) return false;
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
  } else if (!css && (strcmp(word, "true") == 0 || strcmp(word, "false") == 0)) {
    token = SASS_BOOLEAN;
  } else if (!css && strcmp(word, "null") == 0) {
    token = SASS_NULL;
  } else if (!css && (strcmp(word, "not") == 0 || strcmp(word, "and") == 0 || strcmp(word, "or") == 0)) {
    token = SASS_OPERATOR;
  } else {
    // Sass operators can precede a group (not(false)); numeric constants
    // followed by a call or module suffix are ordinary names instead.
    if (lexer->lookahead == '.' || lexer->lookahead == '(') return false;
    if (strcmp(folded, "pi") != 0 && strcmp(folded, "e") != 0 && strcmp(folded, "infinity") != 0 &&
        strcmp(folded, "-infinity") != 0 && strcmp(folded, "nan") != 0) return false;
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
  // CSS strings and comments keep `#{` literal; check them before skipping whitespace, which is their content.
  if (css && valid_symbols[LITERAL_DOUBLE_INTERPOLATION]) {
    return scan_literal_interpolation(lexer, LITERAL_DOUBLE_INTERPOLATION);
  }
  if (css && valid_symbols[LITERAL_SINGLE_INTERPOLATION]) {
    return scan_literal_interpolation(lexer, LITERAL_SINGLE_INTERPOLATION);
  }
  if (css && valid_symbols[LITERAL_COMMENT_INTERPOLATION]) {
    return scan_literal_interpolation(lexer, LITERAL_COMMENT_INTERPOLATION);
  }
  if (valid_symbols[DESCENDANT] && css_space(lexer->lookahead)) {
    while (css_space(lexer->lookahead)) lexer->advance(lexer, true);
    // Zero width: the token ends before any character peeked below.
    lexer->mark_end(lexer);
    lexer->result_symbol = DESCENDANT;
    int32_t first = lexer->lookahead;
    if (first == ':' || first == '-' || first == '|') return selector_start_after(lexer, css);
    if (selector_start(first)) return true;
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
    bool complex = false;
    lexer->result_symbol = DIMENSION_UNIT;
    return scan_unit(lexer, css, true, &complex);
  }
  while (css_space(lexer->lookahead)) lexer->advance(lexer, true);
  if (valid_symbols[SCALAR_NUMBER] || valid_symbols[DIMENSION_NUMBER]) {
    // A signed number keeps the unit and comment boundaries below; `-infinity` stays a keyword.
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
  if (valid_symbols[IMPORTANT_BANG] && lexer->lookahead == '!') return scan_important_bang(lexer);
  // A CSS fallback can offer both typed values and literal balanced groups.
  // Resolve its literal opener before attempting an identifier-shaped call.
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
    language.external_scanner.create = css_scanner_create;
    atomic_store_explicit(&initialized, 2, memory_order_release);
  } else {
    while (atomic_load_explicit(&initialized, memory_order_acquire) != 2) {}
  }
  return &language;
}
