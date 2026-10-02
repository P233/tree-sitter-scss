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
  STAR_LINE_BREAK,
  UNFINISHED_HEADER,
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

static bool line_break(int32_t character) {
  return character == '\n' || character == '\r' || character == '\f';
}

typedef struct {
  unsigned groups;
  int32_t quote;
  bool url;
} InterpolationContext;

typedef struct {
  bool is_matched;
  unsigned budget;
} InterpolationStep;

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
// Every nested opener spends NESTED_OPENER_COST from the caller's budget, at most LOOKAHEAD_LIMIT, which it returns.
// The final opener can exhaust it, so round up; no independent depth limit is needed.
static InterpolationStep skip_interpolation(TSLexer *lexer, bool css, int32_t host, unsigned budget) {
  // The frame capacity below holds only while the budget stays within LOOKAHEAD_LIMIT.
  if (budget > LOOKAHEAD_LIMIT) budget = LOOKAHEAD_LIMIT;
  InterpolationContext context = {0};
  InterpolationContext parents[(LOOKAHEAD_LIMIT + NESTED_OPENER_COST - 1) / NESTED_OPENER_COST];
  unsigned depth = 0;
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
          while (budget && css_space(lexer->lookahead) && !line_break(lexer->lookahead)) {
            budget--;
            lexer->advance(lexer, false);
          }
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
      // A closed opener returns its charge, so only openers still open limit the depth.
      budget += NESTED_OPENER_COST;
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
  return (InterpolationStep){matched, budget};
}

// Skips a comment after its `/`, one budget step per character, and returns the budget left.
static unsigned skip_comment(TSLexer *lexer, unsigned budget) {
  bool is_block = lexer->lookahead == '*';
  bool is_after_star = false;
  lexer->advance(lexer, false);
  for (; budget && !lexer->eof(lexer); budget--) {
    int32_t character = lexer->lookahead;
    // A line comment ends where the grammar's inline_comment does.
    if (!is_block && (character == '\n' || character == '\r')) break;
    lexer->advance(lexer, false);
    if (is_block && is_after_star && character == '/') break;
    is_after_star = character == '*';
  }
  return budget;
}

typedef struct {
  int32_t character;
  unsigned budget;
} CodeStep;

// Whether this consumed character opens a comment.
static bool opens_comment(TSLexer *lexer, int32_t character, unsigned groups) {
  // Inside a group `//` belongs to a URL such as `url(//a.test)`; a line comment there would end the line anyway.
  return character == '/' && (lexer->lookahead == '*' || (lexer->lookahead == '/' && !groups));
}

// Consumes the rest of a comment, escape, string or interpolation that starts with this character, if it starts one.
static CodeStep skip_code_unit(TSLexer *lexer, bool css, int32_t character, unsigned groups, unsigned budget) {
  if (opens_comment(lexer, character, groups)) {
    // Comments spend the same budget, so a long one is never rescanned in full from every line.
    return (CodeStep){0, skip_comment(lexer, budget)};
  }
  if (character == '\\') {
    if (!lexer->eof(lexer)) lexer->advance(lexer, false);
  } else if (character == '#' && lexer->lookahead == '{') {
    lexer->advance(lexer, false);
    budget = skip_interpolation(lexer, css, HOST_CODE, budget).budget;
  } else if (character == '"' || character == '\'') {
    // CSS strings end at a line break, so an unfinished one cannot hide the rest of the statement.
    while (budget && !lexer->eof(lexer) && !line_break(lexer->lookahead)) {
      budget--;
      int32_t inner = lexer->lookahead;
      lexer->advance(lexer, false);
      if (inner == character) break;
      if (inner == '\\') {
        if (!lexer->eof(lexer)) lexer->advance(lexer, false);
      } else if (inner == '#' && lexer->lookahead == '{' && !css) {
        lexer->advance(lexer, false);
        budget = skip_interpolation(lexer, css, HOST_CODE, budget).budget;
      }
    }
  } else {
    return (CodeStep){character, budget};
  }
  return (CodeStep){0, budget};
}

// Characters that can start a comment, escape, string or interpolation, which skip_code_unit consumes whole.
static bool starts_code_unit(int32_t character) {
  return character == '/' || character == '\\' || character == '#' || character == '"' || character == '\'';
}

// After a line break, a group closing around this point continues the construct, and so does a selector's block.
static bool continues_past_line(TSLexer *lexer, bool css, bool is_selector) {
  unsigned groups = 0;
  // An exhausted budget keeps a selector going and lets a value end.
  for (unsigned limit = LOOKAHEAD_LIMIT; limit && !lexer->eof(lexer); limit--) {
    int32_t character = lexer->lookahead;
    lexer->advance(lexer, false);
    if (starts_code_unit(character)) {
      CodeStep step = skip_code_unit(lexer, css, character, groups, limit);
      limit = step.budget;
      if (!limit) return is_selector;
      character = step.character;
    }
    if (character == '(' || character == '[') {
      groups++;
    } else if (character == ')' || character == ']') {
      if (!groups) return true;
      groups--;
    } else if (character == '{') {
      return is_selector;
    } else if (character == '}' || (character == ';' && is_selector)) {
      return false;
    }
  }
  return is_selector && !lexer->eof(lexer);
}

// Finishes a name, which may contain interpolation, and whether a colon that cannot start a pseudo-class follows it.
static bool declaration_rest(TSLexer *lexer, bool css, bool has_name) {
  unsigned budget = LOOKAHEAD_LIMIT;
  for (; budget; budget--) {
    if (has_name ? name_character(lexer->lookahead) : name_start(lexer->lookahead)) {
      lexer->advance(lexer, false);
    } else if (lexer->lookahead == '#') {
      lexer->advance(lexer, false);
      if (lexer->lookahead != '{') return false;
      lexer->advance(lexer, false);
      // Interpolation may hold quotes and braces of its own.
      InterpolationStep step = skip_interpolation(lexer, css, HOST_CODE, budget);
      if (!step.is_matched || !step.budget) return false;
      budget = step.budget;
    } else {
      break;
    }
    has_name = true;
  }
  if (!has_name) return false;
  for (; budget && css_space(lexer->lookahead); budget--) lexer->advance(lexer, false);
  if (lexer->lookahead != ':') return false;
  lexer->advance(lexer, false);
  int32_t next = lexer->lookahead;
  // A pseudo-class name touches its colon, while a minus before a digit starts a negative value.
  if (next == '-') {
    lexer->advance(lexer, false);
    return digit(lexer->lookahead) || lexer->lookahead == '.';
  }
  return css_space(next) || !(name_start(next) || next == '\\' || next == '#' || next == ':');
}

// The name-level check: a name, which may carry the `*` hack or interpolation, then a colon no pseudo-class takes.
static bool declaration_name_follows(TSLexer *lexer, bool css) {
  if (lexer->lookahead == '*') lexer->advance(lexer, false);
  if (lexer->lookahead == '-') lexer->advance(lexer, false);
  if (lexer->lookahead == '-') lexer->advance(lexer, false);
  return declaration_rest(lexer, css, false);
}

static bool selector_separator(int32_t character) {
  return character == ',' || character == '>' || character == '+' || character == '~' || character == '(';
}

// A separator, or a compound-part start touching the compound before it, can leave a selector line unfinished.
static bool tail_start(int32_t character, bool is_touching) {
  return selector_separator(character) ||
         (is_touching && (character == '.' || character == ':' || character == '#' || character == '[' ||
                          character == '%' || character == '|'));
}

// Whether only such punctuation ends the line above a declaration; the token claims it.
static bool tail_ends_statement(TSLexer *lexer, bool css) {
  unsigned budget = LOOKAHEAD_LIMIT;
  unsigned interpolations = 0;
  for (; budget; budget--) {
    int32_t character = lexer->lookahead;
    if (character == ' ' || character == '\t') {
      lexer->advance(lexer, false);
      continue;
    }
    if (character == '#') {
      lexer->advance(lexer, false);
      if (lexer->lookahead == '{') {
        lexer->advance(lexer, false);
        interpolations++;
      }
    } else if (character == '}' && interpolations) {
      lexer->advance(lexer, false);
      interpolations--;
    } else if (character == '$' && interpolations) {
      // A variable without its name yet, as in `#{$}`, leaves the interpolation unfinished too.
      lexer->advance(lexer, false);
    } else if (tail_start(character, true) || character == ')' || character == ']') {
      lexer->advance(lexer, false);
    } else {
      break;
    }
    lexer->mark_end(lexer);
  }
  if (!budget) return false;
  bool has_crossed_line = false;
  for (;;) {
    for (; budget && css_space(lexer->lookahead); budget--) {
      has_crossed_line |= line_break(lexer->lookahead);
      lexer->advance(lexer, false);
    }
    if (!budget) return false;
    if (lexer->lookahead != '/') break;
    lexer->advance(lexer, false);
    if (lexer->lookahead != '/' && lexer->lookahead != '*') return false;
    budget = skip_comment(lexer, budget);
    if (!budget) return false;
  }
  return has_crossed_line && declaration_name_follows(lexer, css);
}

// Whether the value after a declaration colon ends with `;` on its own line, unlike a map or list entry.
static bool value_ends_on_line(TSLexer *lexer, bool css) {
  unsigned groups = 0;
  for (unsigned limit = LOOKAHEAD_LIMIT; limit && !lexer->eof(lexer); limit--) {
    if (line_break(lexer->lookahead)) return false;
    int32_t character = lexer->lookahead;
    lexer->advance(lexer, false);
    if (starts_code_unit(character)) {
      CodeStep step = skip_code_unit(lexer, css, character, groups, limit);
      limit = step.budget;
      if (!limit) return false;
      character = step.character;
    }
    if (character == '(' || character == '[') {
      groups++;
    } else if (character == ')' || character == ']') {
      if (!groups) return false;
      groups--;
    } else if (character == '{' || character == '}') {
      return false;
    } else if (character == ';' && !groups) {
      return true;
    }
  }
  return false;
}

// The line-level check after a declaration colon: the value ends on its line, outside any group still open around it.
static bool declaration_line_rest(TSLexer *lexer, bool css) {
  return value_ends_on_line(lexer, css) && !continues_past_line(lexer, css, false);
}

// Whether an at-rule header meets a whole declaration line before its block opens; the token claims the header.
static bool header_ends_early(TSLexer *lexer, bool css) {
  unsigned groups = 0;
  // Within a group only the header's first line is checked, so a header runs the declaration checks at most twice.
  bool is_first_line = true;
  for (unsigned limit = LOOKAHEAD_LIMIT; limit && !lexer->eof(lexer); limit--) {
    int32_t character = lexer->lookahead;
    if (line_break(character) && (!groups || is_first_line)) {
      is_first_line = false;
      for (; limit && css_space(lexer->lookahead); limit--) lexer->advance(lexer, false);
      if (!limit) return false;
      // An open group ends the header there only if it never closes.
      if (declaration_name_follows(lexer, css)) {
        return groups ? declaration_line_rest(lexer, css) : value_ends_on_line(lexer, css);
      }
      // A failed name check consumes only a name, its interpolation and the whitespace after it.
      if (!groups) return false;
      continue;
    }
    lexer->advance(lexer, false);
    // A comment after the header stays a comment rather than joining the error.
    bool is_comment = opens_comment(lexer, character, groups);
    if (starts_code_unit(character)) {
      CodeStep step = skip_code_unit(lexer, css, character, groups, limit);
      limit = step.budget;
      if (!limit) return false;
      character = step.character;
    }
    if (character == '(' || character == '[') {
      groups++;
    } else if (character == ')' || character == ']') {
      if (!groups) return false;
      groups--;
    } else if (character == '{' || character == '}' || character == ';') {
      return false;
    }
    if (!css_space(character) && !is_comment) lexer->mark_end(lexer);
  }
  return false;
}

// Longest at-rule name the header check knows (`starting-style`) plus its terminator.
enum { AT_RULE_BUFFER = 15 };

// Block at-rules nested among declarations: Sass directives as spelled, CSS ones in any case.
static bool can_claim_header(const char name[AT_RULE_BUFFER]) {
  static const char *const sass[] = {"if", "each", "for", "while", "at-root"};
  static const char *const css[] = {"media", "supports", "container", "layer", "scope", "starting-style"};
  for (unsigned index = 0; index < sizeof(sass) / sizeof(*sass); index++) {
    if (strcmp(name, sass[index]) == 0) return true;
  }
  char folded[AT_RULE_BUFFER];
  memcpy(folded, name, sizeof(folded));
  lowercase(folded);
  for (unsigned index = 0; index < sizeof(css) / sizeof(*css); index++) {
    if (strcmp(folded, css[index]) == 0) return true;
  }
  return false;
}

// No state accepts the token, so the parser skips the unfinished header as one error and resumes at the declaration.
static bool scan_unfinished_header(TSLexer *lexer, bool css) {
  lexer->advance(lexer, false);
  char name[AT_RULE_BUFFER];
  unsigned length = 0;
  while (length + 1 < AT_RULE_BUFFER && lexer->lookahead < 0x80 && name_character(lexer->lookahead)) {
    name[length++] = (char)lexer->lookahead;
    lexer->advance(lexer, false);
  }
  name[length] = '\0';
  // Other at-rules, such as `@mixin` at the top level or an `@else` with no `@if`, keep their own recovery.
  if (name_character(lexer->lookahead) || lexer->lookahead == '\\' || !can_claim_header(name)) return false;
  lexer->mark_end(lexer);
  lexer->result_symbol = UNFINISHED_HEADER;
  return header_ends_early(lexer, css);
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

// Whether this line, whose name is partly read, is a whole declaration outside any group still open around it.
static bool value_ends_before(TSLexer *lexer, bool css, bool has_name) {
  lexer->result_symbol = STATEMENT_BREAK;
  return declaration_rest(lexer, css, has_name) && declaration_line_rest(lexer, css);
}

// The same from the start of the line, where a name may begin with the `*` hack or dashes.
static bool value_ends_before_line(TSLexer *lexer, bool css) {
  lexer->result_symbol = STATEMENT_BREAK;
  return declaration_name_follows(lexer, css) && declaration_line_rest(lexer, css);
}

// `word` holds `length` characters already consumed by the caller; a name that is no keyword may end the value instead.
static bool scan_keyword(TSLexer *lexer, const bool *valid_symbols, bool css, char *word, unsigned length,
                         bool can_end_value) {
  bool escaped = false;
  bool has_name = length ? name_character(lexer->lookahead) || lexer->lookahead == '\\' : name_start(lexer->lookahead);
  if (!scan_identifier(lexer, word, length, css, &escaped)) {
    return can_end_value && value_ends_before(lexer, css, has_name);
  }
  // Interpolation extends the identifier; no keyword may claim its prefix.
  if (lexer->lookahead == '#') return can_end_value && value_ends_before(lexer, css, true);
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
      return can_end_value && value_ends_before(lexer, css, true);
    }
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
  bool css = payload == &css_dialect;
  if (valid_symbols[IF_END]) {
    // Zero width: marking before the @else lookahead makes the whole if node own that dependency.
    lexer->mark_end(lexer);
    bool has_else = skip_trivia(lexer) && scan_else_keyword(lexer);
    lexer->result_symbol = IF_END;
    if (!has_else) return true;
    // An else header cut off by a declaration line is skipped as one error, with the trivia before it.
    lexer->mark_end(lexer);
    lexer->result_symbol = UNFINISHED_HEADER;
    return header_ends_early(lexer, css);
  }
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
    return !skip_interpolation(lexer, css, host, LOOKAHEAD_LIMIT).is_matched;
  }
  bool has_crossed_line = false;
  if ((valid_symbols[DESCENDANT] || valid_symbols[SPACE_BEFORE_COLON]) &&
      (css_space(lexer->lookahead) || tail_start(lexer->lookahead, true))) {
    bool has_space = css_space(lexer->lookahead);
    // A token decided across a line stays at the end of the line above, so the next line keeps its whitespace.
    lexer->mark_end(lexer);
    while (css_space(lexer->lookahead)) {
      has_crossed_line |= line_break(lexer->lookahead);
      lexer->advance(lexer, true);
    }
    // Zero width: the token ends before any character peeked below.
    if (!has_crossed_line) lexer->mark_end(lexer);
    int32_t first = lexer->lookahead;
    if (!has_crossed_line && valid_symbols[DESCENDANT] && !valid_symbols[STATEMENT_BREAK] &&
        tail_start(first, !has_space)) {
      lexer->result_symbol = STATEMENT_BREAK;
      return tail_ends_statement(lexer, css);
    }
    // Without a descendant, other whitespace-led tokens such as `true` in `(a true)` still get scanned below.
    if (has_space && (first == ':' || valid_symbols[DESCENDANT])) {
      lexer->result_symbol = first == ':' ? SPACE_BEFORE_COLON : DESCENDANT;
      bool is_ambiguous_start = first == ':' || first == '-' || first == '|';
      if (is_ambiguous_start ? selector_start_after(lexer) : selector_start(first)) {
        if (!has_crossed_line) return true;
        // A spaced colon on its own line may still belong to a declaration above it.
        if (first == ':') return continues_past_line(lexer, css, true);
        // Another line continues the statement unless it starts a declaration, which selector states never accept.
        if (!declaration_name_follows(lexer, css)) return true;
        lexer->result_symbol = valid_symbols[STAR_LINE_BREAK] ? STAR_LINE_BREAK : STATEMENT_BREAK;
        return true;
      }
      if (is_ambiguous_start) return false;
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
  // Recovering from an unfinished selector lexes the punctuation that ended its line again in the statement list.
  if (valid_symbols[STATEMENT_BREAK] && valid_symbols[STATEMENT_COMMENT_START] && !valid_symbols[DESCENDANT]) {
    bool is_touching = true;
    while (lexer->lookahead == ' ' || lexer->lookahead == '\t') {
      is_touching = false;
      lexer->advance(lexer, true);
    }
    if (tail_start(lexer->lookahead, is_touching)) {
      if (lexer->lookahead == '.') {
        lexer->advance(lexer, false);
        if (digit(lexer->lookahead)) {
          return (valid_symbols[SCALAR_NUMBER] || valid_symbols[DIMENSION_NUMBER]) &&
                 scan_number_digits(lexer, css, true) && valid_symbols[lexer->result_symbol];
        }
        lexer->mark_end(lexer);
      }
      lexer->result_symbol = STATEMENT_BREAK;
      return tail_ends_statement(lexer, css);
    }
  }
  // A declaration value, also one in a feature query, accepts `!important`; maps, arguments and raw values do not.
  bool is_value_state = valid_symbols[IMPORTANT_BANG] && !valid_symbols[STATEMENT_BREAK] &&
                        (valid_symbols[SASS_BOOLEAN] || valid_symbols[SASS_NULL] || valid_symbols[SASS_OPERATOR] ||
                         valid_symbols[CALCULATION_CONSTANT] || valid_symbols[CSS_VAR_FUNCTION_NAME]);
  bool is_url = valid_symbols[LITERAL_CSS_URL] && !valid_symbols[STATEMENT_BREAK];
  // Zero width at the end of the line above: a declaration that starts the next line ends the value before it.
  if ((is_value_state || is_url) && css_space(lexer->lookahead)) lexer->mark_end(lexer);
  while (css_space(lexer->lookahead)) {
    has_crossed_line |= line_break(lexer->lookahead);
    lexer->advance(lexer, true);
  }
  if (valid_symbols[STATEMENT_BREAK] && valid_symbols[STATEMENT_COMMENT_START] && lexer->lookahead == '@') {
    return scan_unfinished_header(lexer, css);
  }
  bool can_end_value = has_crossed_line && is_value_state;
  // Sass reads a line-leading `*` as multiplication, but a `*` hack declaration still ends the value.
  if (can_end_value && lexer->lookahead == '*') {
    return value_ends_before_line(lexer, css);
  }
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
        return scan_keyword(lexer, valid_symbols, css, word, 1, can_end_value);
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
    return scan_keyword(lexer, valid_symbols, css, word, 0, can_end_value);
  }
  // A Sass url( payload is never a declaration, so one on a later line ends an unclosed url( above it.
  if (!css && is_url && has_crossed_line) {
    return value_ends_before_line(lexer, css);
  }
  if (!css || !valid_symbols[LITERAL_CSS_URL]) return false;
  bool content = false;
  // A payload on a later line shaped `name:` may instead start a declaration below an unclosed url(.
  bool is_name = has_crossed_line && (name_start(lexer->lookahead) || lexer->lookahead == '-');
  bool has_colon = false;
  while (!lexer->eof(lexer) && !css_space(lexer->lookahead) &&
         lexer->lookahead != '(' && lexer->lookahead != ')' &&
         lexer->lookahead != '"' && lexer->lookahead != '\'' && lexer->lookahead != '\\') {
    if (has_colon || !(name_character(lexer->lookahead) || lexer->lookahead == ':')) is_name = false;
    has_colon |= lexer->lookahead == ':';
    lexer->advance(lexer, false);
    content = true;
  }
  // Mark before the lookahead below, so a payload that starts no declaration keeps its own end.
  lexer->mark_end(lexer);
  bool is_declaration = is_name && has_colon && css_space(lexer->lookahead) && declaration_line_rest(lexer, css);
  // A `name:` payload starting a declaration line ends the url( as a statement break, which includes it.
  lexer->result_symbol = is_declaration ? STATEMENT_BREAK : LITERAL_CSS_URL;
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
