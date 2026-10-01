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
  INCOMPLETE_VARIABLE_PREFIX,
  MISSING_VARIABLE_NAME,
  STATEMENT_BREAK,
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
  while (lexer->lookahead == '/') {
    lexer->advance(lexer, false);
    if (lexer->lookahead != '*') return false;
    lexer->advance(lexer, false);
    if (!skip_block_comment(lexer)) return false;
  }
  if (lexer->lookahead != '|') return false;
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

static bool line_break(int32_t character) {
  return character == '\n' || character == '\r' || character == '\f';
}

typedef struct {
  unsigned groups;
  int32_t quote;
  bool url;
} InterpolationContext;

// Steps a bounded lookahead may take, each at least one character; the
// longest interpolation in the reference corpus has 121. A nested opener costs
// extra, so a run of unclosed openers ends the scan after a few of them.
enum { LOOKAHEAD_LIMIT = 1024, NESTED_OPENER_COST = 64 };

enum { HOST_CODE = 0, HOST_COMMENT = '*' };

// Whether a host whose opener stayed literal would end at `character`: a
// comment at `*/`, a string at its own quote or at a line break.
static bool ends_literal_host(int32_t host, int32_t character, int32_t next) {
  if (host == HOST_COMMENT) return character == '*' && next == '/';
  return host != HOST_CODE && (character == host || line_break(character));
}

// The opening `#{` has been consumed; `host` is HOST_CODE, HOST_COMMENT, or the
// quote of the host string. Pairing follows SassScript lexing and may span
// lines, but never leaves the opener's containers: it fails at a block,
// statement, or declaration boundary, at the closer of a group the expression
// does not own, at the end of the host comment, and at the lookahead limit.
// Every nested opener spends NESTED_OPENER_COST from the same decreasing budget.
// The final opener can exhaust it, so round up; no independent depth limit is needed.
static bool skip_interpolation(TSLexer *lexer, bool css, int32_t host) {
  InterpolationContext context = {0};
  InterpolationContext parents[(LOOKAHEAD_LIMIT + NESTED_OPENER_COST - 1) / NESTED_OPENER_COST];
  unsigned depth = 0;
  unsigned budget = LOOKAHEAD_LIMIT;
  bool has_crossed_host_end = false;
  bool matched = false;
  while (budget && !lexer->eof(lexer)) {
    int32_t character = lexer->lookahead;
    bool plain = !context.quote && !context.url;
    if (plain) {
      // Blocks, statements, and declarations cannot occur in an expression,
      // and a group opened inside it must close before the expression does.
      if (character == '{' || (context.groups && character == '}')) break;
      if (!context.groups && (character == ';' || character == ':' || character == '@' ||
                              character == ')' || character == ']')) break;
    } else if (line_break(character)) {
      // Nested strings and unquoted URLs cannot continue on another line.
      break;
    }
    if (context.url && (character == '(' || character == ')')) {
      context.url = false;
      if (character == ')') {
        context.groups--;
        lexer->advance(lexer, false);
        budget--;
      }
      continue;
    }
    if (plain && (name_character(character) || character == '\\' || character == '$' || character == '.')) {
      char name[KEYWORD_BUFFER];
      bool simple_name = scan_identifier(lexer, name, 0, css, NULL);
      bool complex = false;
      budget--;
      // Consume the rest of a qualified or long name without
      // recognizing a trailing `url` as a separate literal call.
      while (budget && (name_character(lexer->lookahead) || lexer->lookahead == '\\' ||
                        lexer->lookahead == '$' || lexer->lookahead == '.')) {
        simple_name = false;
        budget--;
        if (lexer->lookahead == '\\') {
          if (!scan_escape(lexer, css, &complex, NULL)) break;
        } else {
          lexer->advance(lexer, false);
        }
      }
      if (simple_name) {
        lowercase(name);
        if (strcmp(name, "progid") == 0 && lexer->lookahead == ':') {
          // IE filter syntax is the one expression that contains a colon.
          do {
            lexer->advance(lexer, false);
          } while (budget && --budget && (name_character(lexer->lookahead) || lexer->lookahead == '.'));
        } else if (strcmp(name, "url") == 0 && lexer->lookahead == '(') {
          lexer->advance(lexer, false);
          context.groups++;
          while (css_space(lexer->lookahead) && !line_break(lexer->lookahead)) lexer->advance(lexer, false);
          // Strings, Sass variables, and nested calls use ordinary expression
          // trivia. An unquoted URL instead owns its slashes and braces.
          if (lexer->lookahead != '"' && lexer->lookahead != '\'' && (css || lexer->lookahead != '$')) {
            context.url = true;
          }
        }
      }
      continue;
    }
    lexer->advance(lexer, false);
    budget--;
    if (plain && character == '/' && (lexer->lookahead == '/' || lexer->lookahead == '*')) {
      // A comment inside the expression hides everything except the host's end.
      bool is_block = lexer->lookahead == '*';
      bool closed = !is_block;
      lexer->advance(lexer, false);
      while (budget && !lexer->eof(lexer) && (is_block || !line_break(lexer->lookahead))) {
        budget--;
        int32_t inner = lexer->lookahead;
        lexer->advance(lexer, false);
        if (ends_literal_host(host, inner, lexer->lookahead)) has_crossed_host_end = true;
        if (is_block && inner == '*' && lexer->lookahead == '/') {
          lexer->advance(lexer, false);
          closed = true;
          break;
        }
      }
      if (!closed) break;
      continue;
    }
    if (ends_literal_host(host, character, lexer->lookahead)) {
      // An expression cannot continue past the end of its own comment.
      if (plain && host == HOST_COMMENT) break;
      has_crossed_host_end = true;
    }
    if (character == '\\') {
      if (!lexer->eof(lexer) && !line_break(lexer->lookahead)) lexer->advance(lexer, false);
    } else if (character == '#' && lexer->lookahead == '{' && (plain || !css)) {
      lexer->advance(lexer, false);
      parents[depth++] = context;
      context = (InterpolationContext){0};
      budget -= budget < NESTED_OPENER_COST ? budget : NESTED_OPENER_COST;
    } else if (!plain) {
      if (character == context.quote) context.quote = 0;
    } else if (character == '"' || character == '\'') {
      context.quote = character;
    } else if (character == '(' || character == '[') {
      context.groups++;
    } else if (character == ')' || character == ']') {
      context.groups--;
    } else if (character == '}') {
      if (!depth) {
        matched = true;
        break;
      }
      context = parents[--depth];
    }
  }
  if (matched && has_crossed_host_end) {
    // The literal reading is as consistent as the paired one, so the pairing
    // stands only if the host visibly goes on: it ends on the closing line, or
    // another interpolation carries it past that line.
    matched = false;
    while (budget && !lexer->eof(lexer) && !line_break(lexer->lookahead)) {
      budget--;
      int32_t character = lexer->lookahead;
      lexer->advance(lexer, false);
      if (ends_literal_host(host, character, lexer->lookahead)) {
        matched = true;
        break;
      }
      if (character == '#' && lexer->lookahead == '{') matched = true;
      else if (character == '}') matched = false;
    }
  }
  return matched;
}

// After a line break, a selector continues if its block opens, or a group around it closes, before the statement ends.
static bool block_follows(TSLexer *lexer, bool css) {
  int32_t quote = 0;
  unsigned groups = 0;
  for (unsigned limit = LOOKAHEAD_LIMIT; !lexer->eof(lexer); limit--) {
    if (!limit) return true;
    if (!quote && lexer->lookahead == '/') {
      skip_trivia(lexer);
      continue;
    }
    int32_t character = lexer->lookahead;
    lexer->advance(lexer, false);
    if (character == '\\') {
      if (!lexer->eof(lexer)) lexer->advance(lexer, false);
    } else if (character == '#' && lexer->lookahead == '{' && (!quote || !css)) {
      lexer->advance(lexer, false);
      skip_interpolation(lexer, css, HOST_CODE);
    } else if (quote) {
      // CSS strings end at a line break, so an unfinished one cannot hide the block.
      if (character == quote || line_break(character)) quote = 0;
    } else if (character == '"' || character == '\'') {
      quote = character;
    } else if (character == '(' || character == '[') {
      groups++;
    } else if (character == ')' || character == ']') {
      if (!groups) return true;
      groups--;
    } else if (character == '{') {
      return true;
    } else if (character == ';' || character == '}') {
      return false;
    }
  }
  return false;
}

// A name whose colon cannot start a pseudo-class begins a declaration.
static bool declaration_follows(TSLexer *lexer) {
  if (lexer->lookahead == '-') lexer->advance(lexer, false);
  if (lexer->lookahead == '-') lexer->advance(lexer, false);
  if (!name_start(lexer->lookahead)) return false;
  while (name_character(lexer->lookahead)) lexer->advance(lexer, false);
  while (css_space(lexer->lookahead)) lexer->advance(lexer, false);
  if (lexer->lookahead != ':') return false;
  lexer->advance(lexer, false);
  int32_t next = lexer->lookahead;
  // A pseudo-class name touches its colon, so anything else starts a value.
  return css_space(next) || !(name_start(next) || next == '-' || next == '\\' || next == '#' || next == ':');
}

static bool selector_separator(int32_t character) {
  return character == ',' || character == '>' || character == '+' || character == '~';
}

// Whether the separator under the lexer ends a selector line above a declaration; the caller has marked the token end.
static bool separator_ends_statement(TSLexer *lexer) {
  lexer->advance(lexer, false);
  bool has_crossed_line = false;
  while (css_space(lexer->lookahead)) {
    has_crossed_line |= line_break(lexer->lookahead);
    lexer->advance(lexer, false);
  }
  return has_crossed_line && declaration_follows(lexer);
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
  if (!scan_identifier(lexer, word, length, css, &escaped)) return false;
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
        strcmp(folded, "-infinity") != 0 && strcmp(folded, "nan") != 0) return false;
    token = CALCULATION_CONSTANT;
  }
  if (!valid_symbols[token]) return false;
  lexer->mark_end(lexer);
  lexer->result_symbol = token;
  return true;
}

bool tree_sitter_scss_external_scanner_scan(void *payload, TSLexer *lexer, const bool *valid_symbols) {
  // MISSING_VARIABLE_NAME is intentionally never emitted. It belongs only to
  // recovery; the complete variable token always owns '$' and its name together.
  // Recovery enables every external token; it must not choose a host context.
  if (valid_symbols[LITERAL_DOUBLE_INTERPOLATION] && valid_symbols[LITERAL_SINGLE_INTERPOLATION]) return false;
  if (valid_symbols[IF_END]) {
    // Zero width: marking before the @else lookahead makes the whole if node own that dependency.
    lexer->mark_end(lexer);
    bool has_else = skip_trivia(lexer) && scan_else_keyword(lexer);
    lexer->result_symbol = IF_END;
    return !has_else;
  }
  bool css = payload == &css_dialect;
  // Text hosts keep an opener literal when no closer is in reach; CSS always does.
  // Check them before skipping whitespace, which is their content.
  int literal_token = valid_symbols[LITERAL_DOUBLE_INTERPOLATION]    ? LITERAL_DOUBLE_INTERPOLATION
                      : valid_symbols[LITERAL_SINGLE_INTERPOLATION]  ? LITERAL_SINGLE_INTERPOLATION
                      : valid_symbols[LITERAL_COMMENT_INTERPOLATION] ? LITERAL_COMMENT_INTERPOLATION
                                                                     : -1;
  if (literal_token >= 0) {
    if (!scan_literal_interpolation(lexer, literal_token)) return false;
    if (css) return true;
    // Keep the token at `#{`; lookahead decides only whether the opener is literal.
    int32_t host = literal_token == LITERAL_DOUBLE_INTERPOLATION   ? '"'
                   : literal_token == LITERAL_SINGLE_INTERPOLATION ? '\''
                                                                   : HOST_COMMENT;
    return !skip_interpolation(lexer, css, host);
  }
  // Zero width before a separator, or an argument opener, that ends a selector line.
  if (valid_symbols[DESCENDANT] && !valid_symbols[STATEMENT_BREAK] &&
      (selector_separator(lexer->lookahead) || lexer->lookahead == '(')) {
    lexer->mark_end(lexer);
    lexer->result_symbol = STATEMENT_BREAK;
    return separator_ends_statement(lexer);
  }
  if ((valid_symbols[DESCENDANT] || valid_symbols[SPACE_BEFORE_COLON]) && css_space(lexer->lookahead)) {
    bool has_crossed_line = false;
    while (css_space(lexer->lookahead)) {
      has_crossed_line |= line_break(lexer->lookahead);
      lexer->advance(lexer, true);
    }
    // Zero width: the token ends before any character peeked below.
    lexer->mark_end(lexer);
    int32_t first = lexer->lookahead;
    // Without a descendant, other whitespace-led tokens such as `true` in `(a true)` still get scanned below.
    if (first == ':' || valid_symbols[DESCENDANT]) {
      lexer->result_symbol = first == ':' ? SPACE_BEFORE_COLON : DESCENDANT;
      bool is_ambiguous_start = first == ':' || first == '-' || first == '|';
      if (is_ambiguous_start ? selector_start_after(lexer) : selector_start(first)) {
        // A selector continues on another line unless the statement is seen to
        // end first; that line then starts a new statement.
        if (!has_crossed_line || block_follows(lexer, css)) return true;
        if (first == ':') return false;
        // Only statement lists accept this token, so error recovery returns to the enclosing list.
        lexer->result_symbol = STATEMENT_BREAK;
        return true;
      }
      if (is_ambiguous_start) return false;
      if (!has_crossed_line && !valid_symbols[STATEMENT_BREAK] && selector_separator(first)) {
        lexer->result_symbol = STATEMENT_BREAK;
        return separator_ends_statement(lexer);
      }
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
  // Where numbers are also valid, a signed number returns here unmatched and relies on the internal number lexer.
  if (valid_symbols[NAMESPACE_PREFIX] &&
      (name_start(lexer->lookahead) || lexer->lookahead == '-' || lexer->lookahead == '\\')) {
    return scan_namespace_prefix(lexer, css);
  }
  // CSS URL payloads own dollar signs, including a bare dollar at the end.
  if (valid_symbols[INCOMPLETE_VARIABLE_PREFIX] && !(css && valid_symbols[LITERAL_CSS_URL]) &&
      lexer->lookahead == '$') {
    lexer->advance(lexer, false);
    lexer->mark_end(lexer);
    lexer->result_symbol = INCOMPLETE_VARIABLE_PREFIX;
    // Any `$` that does not start a name is unfinished; recovery supplies the
    // missing name, so a later word or comment can never join it.
    return !name_start(lexer->lookahead) && lexer->lookahead != '-' && lexer->lookahead != '\\';
  }
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
  if (valid_symbols[IMPORTANT_BANG] && lexer->lookahead == '!') return scan_important_bang(lexer, css);
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
