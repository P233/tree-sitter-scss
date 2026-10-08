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

// A non-null `escaped` enables escape decoding; literal-only callers pass null, so an escape fails their scan.
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

static bool line_break(int32_t character) {
  return character == '\n' || character == '\r' || character == '\f';
}

// Steps one statement-break lookahead may take, each at least one character, so a scan never walks the whole file.
enum { LOOKAHEAD_LIMIT = 1024 };

// Consumes interpolation after its `#{`; its closer must follow on the same line.
static bool skip_line_interpolation(TSLexer *lexer, unsigned *budget) {
  for (unsigned depth = 1; depth;) {
    if (!*budget || lexer->eof(lexer) || line_break(lexer->lookahead)) return false;
    (*budget)--;
    int32_t character = lexer->lookahead;
    lexer->advance(lexer, false);
    if (character == '{') depth++;
    if (character == '}') depth--;
  }
  return true;
}

// Consumes a comment after its `/` and returns whether it crossed a line; a line comment stops before its break.
static bool skip_comment(TSLexer *lexer, unsigned *budget) {
  bool is_block = lexer->lookahead == '*';
  bool is_after_star = false;
  bool has_crossed_line = false;
  lexer->advance(lexer, false);
  for (; *budget && !lexer->eof(lexer); (*budget)--) {
    int32_t character = lexer->lookahead;
    if (!is_block && line_break(character)) break;
    has_crossed_line |= line_break(character);
    lexer->advance(lexer, false);
    if (is_block && is_after_star && character == '/') break;
    is_after_star = character == '*';
  }
  return has_crossed_line;
}

// Consumes a quoted string after its quote and returns whether it closed; strings end at a line break.
static bool skip_string(TSLexer *lexer, int32_t quote, unsigned *budget) {
  for (; *budget && !lexer->eof(lexer) && !line_break(lexer->lookahead); (*budget)--) {
    int32_t character = lexer->lookahead;
    lexer->advance(lexer, false);
    if (character == quote) return true;
    if (character == '\\' && !line_break(lexer->lookahead)) lexer->advance(lexer, false);
  }
  return false;
}

// Whether the consumed `character` opens a string, block comment or interpolation, which skip_unit consumes.
static bool opens_unit(TSLexer *lexer, int32_t character) {
  return character == '"' || character == '\'' || (character == '#' && lexer->lookahead == '{') ||
         (character == '/' && lexer->lookahead == '*');
}

// Consumes the rest of a unit that opens_unit accepted and returns whether it closed within the budget.
static bool skip_unit(TSLexer *lexer, int32_t character, unsigned *budget) {
  if (character == '#') {
    lexer->advance(lexer, false);
    return skip_line_interpolation(lexer, budget);
  }
  if (character == '/') {
    skip_comment(lexer, budget);
    return *budget && !lexer->eof(lexer);
  }
  return skip_string(lexer, character, budget);
}

// The rest of this line is a value ending with `;` outside any group, as a declaration line is.
static bool value_ends_on_line(TSLexer *lexer, unsigned *budget) {
  unsigned groups = 0;
  while (*budget && !lexer->eof(lexer) && !line_break(lexer->lookahead)) {
    (*budget)--;
    int32_t character = lexer->lookahead;
    lexer->advance(lexer, false);
    if (opens_unit(lexer, character)) {
      if (!skip_unit(lexer, character, budget)) return false;
    } else if (character == '/' && lexer->lookahead == '/' && !groups) {
      return false;
    } else if (character == '(' || character == '[') {
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

// Whether a group still open around this point may close before the next block; an unknown answer counts as yes.
static bool group_closes_ahead(TSLexer *lexer, unsigned *budget) {
  unsigned groups = 0;
  while (!lexer->eof(lexer)) {
    if (!*budget) return true;
    (*budget)--;
    int32_t character = lexer->lookahead;
    lexer->advance(lexer, false);
    if (opens_unit(lexer, character)) {
      if (!skip_unit(lexer, character, budget)) return true;
    } else if (character == '/' && lexer->lookahead == '/' && !groups) {
      skip_comment(lexer, budget);
    } else if (character == '(' || character == '[') {
      groups++;
    } else if (character == ')' || character == ']') {
      if (!groups) return true;
      groups--;
    } else if (character == '{' || character == '}') {
      return false;
    }
  }
  return false;
}

// Inside a group, a declaration line's value ends on the line and the group never closes after it.
static bool group_line_rest(TSLexer *lexer, unsigned *budget) {
  return value_ends_on_line(lexer, budget) && !group_closes_ahead(lexer, budget);
}

typedef enum { NO_DECLARATION, DECLARATION, TOUCHING_COLON } DeclarationStart;

// Reads a declaration name and its colon; a name touching the colon may still be a pseudo-class.
static DeclarationStart declaration_start(TSLexer *lexer, bool has_name, unsigned *budget) {
  if (!has_name) {
    if (lexer->lookahead == '-') lexer->advance(lexer, false);
    if (lexer->lookahead == '-') lexer->advance(lexer, false);
  }
  for (; *budget; has_name = true) {
    (*budget)--;
    if (has_name ? name_character(lexer->lookahead) : name_start(lexer->lookahead)) {
      lexer->advance(lexer, false);
    } else if (lexer->lookahead == '#') {
      lexer->advance(lexer, false);
      if (lexer->lookahead != '{') return NO_DECLARATION;
      lexer->advance(lexer, false);
      if (!skip_line_interpolation(lexer, budget)) return NO_DECLARATION;
    } else {
      break;
    }
  }
  if (!has_name) return NO_DECLARATION;
  for (; *budget && css_space(lexer->lookahead); (*budget)--) lexer->advance(lexer, false);
  if (lexer->lookahead != ':') return NO_DECLARATION;
  lexer->advance(lexer, false);
  int32_t next = lexer->lookahead;
  if (next == ':') return NO_DECLARATION;
  // A minus before a digit starts a negative value.
  if (next == '-') {
    lexer->advance(lexer, false);
    return digit(lexer->lookahead) || lexer->lookahead == '.' ? DECLARATION : TOUCHING_COLON;
  }
  bool is_touching = name_start(next) || next == '\\' || next == '#';
  return css_space(next) || !is_touching ? DECLARATION : TOUCHING_COLON;
}

// A declaration starts here: its name and colon, and its whole line when the colon touches a name.
static bool declaration_name_follows(TSLexer *lexer, unsigned *budget) {
  DeclarationStart start = declaration_start(lexer, false, budget);
  return start == DECLARATION || (start == TOUCHING_COLON && value_ends_on_line(lexer, budget));
}

// A combinator or comma, or a compound part touching the compound before it, can leave a selector line unfinished.
static bool tail_start(int32_t character, bool is_touching) {
  return character == ',' || character == '>' || character == '+' || character == '~' ||
         (is_touching && (character == '.' || character == ':' || character == '#' || character == '[' ||
                          character == '%' || character == '|' || character == '('));
}

// Whether only such punctuation ends the line above a declaration; the token claims it.
static bool tail_ends_statement(TSLexer *lexer, unsigned token) {
  unsigned budget = LOOKAHEAD_LIMIT;
  unsigned interpolations = 0;
  bool is_touching = true;
  for (; budget; budget--) {
    int32_t character = lexer->lookahead;
    if (character == ' ' || character == '\t') {
      lexer->advance(lexer, false);
      is_touching = false;
      continue;
    }
    // A pseudo's parenthesis touches it; after a space, `(` opens a value group instead.
    if (character == '(' && !is_touching) break;
    if (character == '#') {
      lexer->advance(lexer, false);
      if (lexer->lookahead == '{') {
        lexer->advance(lexer, false);
        interpolations++;
      }
    } else if ((character == '}' || character == '$') && interpolations) {
      // `#{}` and `#{$}` being typed leave the line unfinished too.
      lexer->advance(lexer, false);
      if (character == '}') interpolations--;
    } else if (tail_start(character, true) || character == ')' || character == ']') {
      lexer->advance(lexer, false);
    } else {
      break;
    }
    is_touching = true;
    lexer->mark_end(lexer);
  }
  bool has_crossed_line = false;
  while (budget) {
    if (css_space(lexer->lookahead)) {
      has_crossed_line |= line_break(lexer->lookahead);
      lexer->advance(lexer, false);
      budget--;
    } else if (lexer->lookahead == '/') {
      lexer->advance(lexer, false);
      if (lexer->lookahead != '/' && lexer->lookahead != '*') return false;
      has_crossed_line |= skip_comment(lexer, &budget);
    } else {
      break;
    }
  }
  lexer->result_symbol = token;
  return budget && has_crossed_line && declaration_name_follows(lexer, &budget);
}

// Whether a header meets a declaration line before its block; the never-valid token covers the header.
static bool header_ends_early(TSLexer *lexer) {
  unsigned groups = 0;
  // Within a group only the header's first line counts, so a header runs the declaration checks at most twice.
  bool is_first_line = true;
  for (unsigned budget = LOOKAHEAD_LIMIT; budget && !lexer->eof(lexer);) {
    int32_t character = lexer->lookahead;
    if (line_break(character) && (!groups || is_first_line)) {
      is_first_line = false;
      for (; budget && css_space(lexer->lookahead); budget--) lexer->advance(lexer, false);
      // An open group ends the header there only if it never closes.
      if (declaration_start(lexer, false, &budget) != NO_DECLARATION) {
        return groups ? group_line_rest(lexer, &budget) : value_ends_on_line(lexer, &budget);
      }
      if (!groups) return false;
      continue;
    }
    budget--;
    lexer->advance(lexer, false);
    if (character == '/' && (lexer->lookahead == '*' || lexer->lookahead == '/')) {
      // A comment after the header stays a comment rather than joining the error.
      skip_comment(lexer, &budget);
      continue;
    }
    if (opens_unit(lexer, character)) {
      if (!skip_unit(lexer, character, &budget)) return false;
    } else if (character == '(' || character == '[') {
      groups++;
    } else if (character == ')' || character == ']') {
      if (!groups) return false;
      groups--;
    } else if (character == '{' || character == '}' || character == ';') {
      return false;
    }
    if (!css_space(character)) lexer->mark_end(lexer);
  }
  return false;
}

// Claims a block at-rule typed among declarations: Sass directives as spelled, nestable CSS ones in any case.
static bool scan_unfinished_header(TSLexer *lexer) {
  static const char *const names[] = {"if", "each", "for", "while", "at-root",
                                      "media", "supports", "container", "layer", "scope", "starting-style"};
  enum { SASS_NAMES = 5, NAME_BUFFER = 15 };
  lexer->advance(lexer, false);
  char name[NAME_BUFFER];
  unsigned length = 0;
  while (length + 1 < NAME_BUFFER && lexer->lookahead < 0x80 && name_character(lexer->lookahead)) {
    name[length++] = (char)lexer->lookahead;
    lexer->advance(lexer, false);
  }
  name[length] = '\0';
  if (name_character(lexer->lookahead) || lexer->lookahead == '\\') return false;
  char folded[NAME_BUFFER];
  memcpy(folded, name, sizeof(folded));
  lowercase(folded);
  bool is_known = false;
  for (unsigned index = 0; index < sizeof(names) / sizeof(*names); index++) {
    is_known |= strcmp(index < SASS_NAMES ? name : folded, names[index]) == 0;
  }
  if (!is_known) return false;
  lexer->mark_end(lexer);
  lexer->result_symbol = UNFINISHED_HEADER;
  return header_ends_early(lexer);
}

// Whether a later value line, whose name may be partly read, is a whole declaration; the break ends the value above.
static bool value_ends_before(TSLexer *lexer, bool has_name) {
  unsigned budget = LOOKAHEAD_LIMIT;
  lexer->result_symbol = STATEMENT_BREAK;
  return declaration_start(lexer, has_name, &budget) != NO_DECLARATION && value_ends_on_line(lexer, &budget);
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

// `word` holds `length` consumed characters; a name that is no keyword may start a declaration ending the value.
static bool scan_keyword(TSLexer *lexer, const bool *valid_symbols, bool css, char *word, unsigned length,
                         bool can_end_value) {
  bool escaped = false;
  bool has_name = length ? name_character(lexer->lookahead) || lexer->lookahead == '\\' : name_start(lexer->lookahead);
  if (!scan_identifier(lexer, word, length, css, &escaped)) return can_end_value && value_ends_before(lexer, has_name);
  // Interpolation extends the identifier; no keyword may claim its prefix.
  if (lexer->lookahead == '#') return can_end_value && value_ends_before(lexer, true);
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
    return true;
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
      return can_end_value && value_ends_before(lexer, true);
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
    if (!(skip_trivia(lexer) && scan_else_keyword(lexer))) return true;
    // An else header cut off by a declaration line is skipped as one error, with the trivia before it.
    lexer->mark_end(lexer);
    lexer->result_symbol = UNFINISHED_HEADER;
    return header_ends_early(lexer);
  }
  // CSS text hosts keep interpolation literal. SCSS always uses the grammar's expression parser.
  // Check before skipping whitespace, which belongs to the host's content.
  int literal_token = valid_symbols[LITERAL_DOUBLE_INTERPOLATION] ? LITERAL_DOUBLE_INTERPOLATION
                      : valid_symbols[LITERAL_SINGLE_INTERPOLATION] ? LITERAL_SINGLE_INTERPOLATION
                      : valid_symbols[LITERAL_COMMENT_INTERPOLATION] ? LITERAL_COMMENT_INTERPOLATION
                                                                     : -1;
  if (literal_token >= 0) return css && scan_literal_interpolation(lexer, literal_token);
  bool has_crossed_line = false;
  // Whitespace in a selector, or punctuation that may leave a selector line unfinished.
  bool is_selector_gap =
    ((valid_symbols[DESCENDANT] || valid_symbols[SPACE_BEFORE_COLON]) && css_space(lexer->lookahead)) ||
    (valid_symbols[DESCENDANT] && !valid_symbols[STATEMENT_BREAK] && tail_start(lexer->lookahead, true));
  if (is_selector_gap) {
    bool has_space = css_space(lexer->lookahead);
    // A break decided across a line ends at the end of the line above, leaving the next line its whitespace.
    lexer->mark_end(lexer);
    while (css_space(lexer->lookahead)) {
      has_crossed_line |= line_break(lexer->lookahead);
      lexer->advance(lexer, true);
    }
    if (!has_crossed_line) lexer->mark_end(lexer);
    int32_t first = lexer->lookahead;
    if (!has_crossed_line && valid_symbols[DESCENDANT] && !valid_symbols[STATEMENT_BREAK] &&
        tail_start(first, !has_space)) {
      return tail_ends_statement(lexer, STATEMENT_BREAK);
    }
    if (has_space && (first == ':' || valid_symbols[DESCENDANT])) {
      lexer->result_symbol = first == ':' ? SPACE_BEFORE_COLON : DESCENDANT;
      bool is_ambiguous_start = first == ':' || first == '-' || first == '|';
      if (is_ambiguous_start ? selector_start_after(lexer) : selector_start(first)) {
        unsigned budget = LOOKAHEAD_LIMIT;
        // A selector ends before a declaration name, on its line or the next; recovery resumes in the statement list.
        if (first != ':' && declaration_name_follows(lexer, &budget)) lexer->result_symbol = STATEMENT_BREAK;
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
      return tail_ends_statement(lexer, STATEMENT_BREAK);
    }
  }
  // A declaration value, also one in a feature query, accepts `!important`; maps, arguments and raw values do not.
  bool is_value_state = valid_symbols[IMPORTANT_BANG] && !valid_symbols[STATEMENT_BREAK] &&
                        (valid_symbols[SASS_BOOLEAN] || valid_symbols[SASS_NULL] || valid_symbols[SASS_OPERATOR] ||
                         valid_symbols[CALCULATION_CONSTANT] || valid_symbols[CSS_VAR_FUNCTION_NAME]);
  // Zero width at the end of the line above: a declaration that starts the next line ends the value before it.
  bool is_url = valid_symbols[LITERAL_CSS_URL] && !valid_symbols[STATEMENT_BREAK];
  if ((is_value_state || is_url) && css_space(lexer->lookahead)) lexer->mark_end(lexer);
  while (css_space(lexer->lookahead)) {
    has_crossed_line |= line_break(lexer->lookahead);
    lexer->advance(lexer, true);
  }
  bool can_end_value = has_crossed_line && is_value_state;
  if (valid_symbols[STATEMENT_BREAK] && valid_symbols[STATEMENT_COMMENT_START]) {
    if (lexer->lookahead == '@') return scan_unfinished_header(lexer);
    // Once shifted, a line-leading combinator or interpolation reaches no break site, so skip such a line as one error.
    int32_t first = lexer->lookahead;
    if (first == '>' || first == '+' || first == '~' || first == '#') {
      return tail_ends_statement(lexer, UNFINISHED_HEADER);
    }
  }
  if (valid_symbols[STATEMENT_COMMENT_START] && lexer->lookahead == '/') {
    return scan_statement_comment_start(lexer);
  }
  // Where numbers are also valid, a signed number relies on the internal number lexer.
  if (valid_symbols[NAMESPACE_PREFIX] &&
      (name_start(lexer->lookahead) || lexer->lookahead == '-' || lexer->lookahead == '\\')) {
    return scan_namespace_prefix(lexer, css);
  }
  // A `$` that does not start a name is unfinished; recovery supplies the missing name. CSS URL payloads own `$`.
  if (valid_symbols[INCOMPLETE_VARIABLE_PREFIX] && !(css && valid_symbols[LITERAL_CSS_URL]) &&
      lexer->lookahead == '$') {
    lexer->advance(lexer, false);
    lexer->mark_end(lexer);
    lexer->result_symbol = INCOMPLETE_VARIABLE_PREFIX;
    return !name_start(lexer->lookahead) && lexer->lookahead != '-' && lexer->lookahead != '\\';
  }
  if (valid_symbols[SCALAR_NUMBER] || valid_symbols[DIMENSION_NUMBER]) {
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
  if (css && valid_symbols[LITERAL_RAW_INTERPOLATION] && lexer->lookahead == '#') {
    return scan_literal_interpolation(lexer, LITERAL_RAW_INTERPOLATION);
  }
  if ((css && valid_symbols[CSS_VAR_FUNCTION_NAME]) || valid_symbols[CALCULATION_CONSTANT] ||
      (!css && (valid_symbols[SASS_BOOLEAN] || valid_symbols[SASS_NULL] || valid_symbols[SASS_OPERATOR]))) {
    char word[KEYWORD_BUFFER];
    return scan_keyword(lexer, valid_symbols, css, word, 0, can_end_value);
  }
  unsigned budget = LOOKAHEAD_LIMIT;
  // A Sass url( payload is never a declaration, so one on a later line ends an unclosed url( above it.
  if (!css && is_url && has_crossed_line) {
    lexer->result_symbol = STATEMENT_BREAK;
    return declaration_start(lexer, false, &budget) != NO_DECLARATION && group_line_rest(lexer, &budget);
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
  bool is_declaration = is_name && has_colon && css_space(lexer->lookahead) && group_line_rest(lexer, &budget);
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
