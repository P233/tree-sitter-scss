const ESCAPE = /\\(?:[0-9a-fA-F]{1,6}[ \t\r\n\f]?|[^\r\n\f0-9a-fA-F])/;
const NAME_START = `(?:[_a-zA-Z\\u0080-\\u{10ffff}]|${ESCAPE.source})`;
const NAME_FRAGMENT = new RegExp(`(?:[-_a-zA-Z0-9\\u0080-\\u{10ffff}]|${ESCAPE.source})+`, "u");
const IDENTIFIER = new RegExp(`(?:--|-?${NAME_START})(?:[-_a-zA-Z0-9\\u0080-\\u{10ffff}]|${ESCAPE.source})*`, "u");
const SIMPLE_UNIT = new RegExp(`${NAME_START}(?:[_a-zA-Z0-9\\u0080-\\u{10ffff}]|${ESCAPE.source})*`, "u");
const URL_NAME = keyword("url", true);
const URL_WORD = token(prec(1, /[^\s()"'\\#$]+/));
const RAW_FUNCTION_NAMES = ["element", "-moz-element", "expression"];
const MATH_FUNCTIONS = [
  "calc",
  "min",
  "max",
  "clamp",
  "round",
  "mod",
  "rem",
  "sin",
  "cos",
  "tan",
  "asin",
  "acos",
  "atan",
  "atan2",
  "pow",
  "sqrt",
  "hypot",
  "log",
  "exp",
  "abs",
  "sign"
];
const NTH_PSEUDOS = ["nth-child", "nth-last-child", "nth-of-type", "nth-last-of-type", "nth-col", "nth-last-col"];
const VALUE_PSEUDOS = [
  "lang",
  "dir",
  "part",
  "highlight",
  "state",
  "scroll-button",
  "active-view-transition-type",
  "view-transition",
  "view-transition-group",
  "view-transition-group-children",
  "view-transition-image-pair",
  "view-transition-old",
  "view-transition-new"
];
const KEYFRAMES_DIRECTIVES = ["keyframes", "-webkit-keyframes", "-moz-keyframes", "-o-keyframes"];
const CSS_STATEMENTS = [
  "charset",
  "layer",
  "property",
  "font-face",
  "font-feature-values",
  "font-palette-values",
  "counter-style",
  "starting-style",
  "view-transition",
  "position-try"
];
const CSS_DIRECTIVES = new Set([
  ...CSS_STATEMENTS,
  "media",
  "supports",
  "container",
  "import",
  "scope",
  ...KEYFRAMES_DIRECTIVES,
  "namespace",
  "page",
  "function"
]);
// Raw words hold text no typed raw token claims, such as paths and `$name` literals. A word that
// starts like a name must continue past it, so a plain name always stays an identifier.
const RAW_WORD_END = String.raw`\s;{}()\[\]"'\\#/!,:*+=<>`;
const RAW_NAME = String.raw`[_a-zA-Z\u0080-\u{10ffff}][\-_a-zA-Z0-9\u0080-\u{10ffff}]*`;
const RAW_WORD = new RegExp(
  String.raw`[$@&?~^|%\x60][^${RAW_WORD_END}]*|${RAW_NAME}[^${RAW_WORD_END}\-_a-zA-Z0-9\u0080-\u{10ffff}][^${RAW_WORD_END}]*|[.#!]`,
  "u"
);

module.exports = grammar({
  name: "scss",
  externals: $ => [
    $._literal_double_interpolation,
    $._literal_single_interpolation,
    $._literal_comment_interpolation,
    $._literal_raw_interpolation,
    $._literal_css_url,
    $._important_bang,
    $._sass_boolean,
    $._sass_null,
    $._sass_operator,
    $._calculation_constant,
    $._css_var_function_name,
    $._scalar_number,
    $._dimension_number,
    $._dimension_unit,
    $._descendant,
    // A spaced colon remains available to both a declaration and a pseudo selector.
    $._space_before_colon,
    $._subtraction_minus,
    $._statement_comment_start,
    $._if_end,
    $._namespace_prefix,
    $._incomplete_variable_prefix,
    $._missing_variable_name,
    // Ends a selector line that cannot continue; selector states reject it, so recovery resumes in a statement list.
    $._statement_break,
    // A line between the `*` hack and its name; selector states never accept it.
    $._star_line_break,
    // Never valid: an at-rule header cut off by a declaration line is skipped as one error.
    $._unfinished_header
  ],
  extras: $ => [/\s/, $.block_comment, $.inline_comment],
  word: $ => $._identifier,
  // Keep nested properties in their declaration's reduction so malformed headers recover locally.
  // Avoid hidden wrappers for completed statements and subclass selector choices.
  inline: $ => [$._nested_property, $._statement, $._subclass_selector],
  conflicts: $ => [
    [$.tag_selector, $._raw_statement_item],
    [$.property_name, $.tag_selector, $._raw_statement_item],
    [$.tag_selector, $._variable],
    [$.property_name, $.tag_selector],
    [$.property_name, $.operator],
    [$._interpolated_identifier, $._expression_atom],
    [$._interpolated_identifier, $._raw_token],
    [$._interpolated_identifier, $._interpolated_pseudo_name],
    [$.named_argument, $._expression_atom],
    [$._value_atom, $._calculation_atom],
    [$._value_atom, $._query_atom],
    [$.list, $.query_group],
    [$.property_name, $.plain_value],
    [$._wrapped_dashed_name, $.plain_value],
    [$.arguments, $._css_fallback_item],
    [$.argument, $._css_fallback_item],
    [$._argument, $._css_fallback_item],
    [$._value, $._css_fallback_item],
    [$._value, $._css_fallback_item, $.map_entry]
  ],
  rules: {
    stylesheet: $ =>
      seq(
        repeat(
          choice(
            alias($._statement_comment, $.block_comment),
            $.rule_set,
            $.variable_declaration,
            $._at_rule,
            ";",
            $._statement_break,
            "<!--",
            "-->"
          )
        ),
        optional($._final_statement)
      ),
    _statement: $ => choice($.rule_set, $.variable_declaration, $.property_declaration, $._at_rule, ";"),
    _block: $ => braced($.declaration_block),
    declaration_block: $ => declarationBlock($, $._statement),
    rule_set: $ => seq(field("selectors", $.selectors), $._block),
    variable_declaration: $ => seq($._variable, ";"),
    _variable: $ =>
      seq(
        // Reusing the selector name rule defers `module.$variable` versus `tag.class` past the dot.
        optional(seq(field("module", alias($._interpolated_identifier, $.module_name)), ".")),
        field("name", $.variable_name),
        ":",
        field("value", $._value),
        repeat(field("flags", $.flag))
      ),
    property_declaration: $ => choice(seq($._property, ";"), $._nested_property),
    _property: $ =>
      choice(
        seq(
          field("name", $.property_name),
          optional($._space_before_colon),
          ":",
          optional(field("value", $._value)),
          optional(field("flags", choice($.flag, alias($._declaration_priority, $.important))))
        ),
        rawProperty($, $._wrapped_dashed_name)
      ),
    _declaration_priority: $ => seq(alias($._important_bang, "!"), alias(keyword("important", true), "important")),
    // As in Sass, a spaced colon touching a name before a block starts a pseudo selector instead.
    _nested_property: $ => seq(field("name", $.property_name), ":", optional(field("value", $._value)), $._block),
    // Sass lets a line separate the `*` hack from its name, so a selector line's end cannot end it.
    // A `*` touching a plain name can only be the hack, so that reading wins equal-cost recoveries.
    property_name: $ =>
      seq(optional(choice(prec.dynamic(1, "*"), seq("*", $._star_line_break))), $._interpolated_identifier),
    // Aliasing this wrapper keeps `dashed_name` as a child of the aliased node.
    _wrapped_dashed_name: $ => $.dashed_name,
    // Custom properties and other author-defined `--` names share one node wherever they are a value or name.
    dashed_name: $ => prec.right(seq($._dashed_name, optional($._identifier_tail))),
    // The literal `--` prefix outranks the identifier token that also matches it.
    _dashed_name: () => token(prec(2, seq("--", optional(NAME_FRAGMENT)))),

    // Each comma item is one named child: a simple, compound, or complex selector.
    // Sass also accepts empty items and a trailing comma.
    selectors: $ => $._selector_list,
    _selector_list: $ => seq($._complex_selector, repeat(seq(",", optional($._complex_selector)))),
    _complex_selector: $ => choice($._compound_selector, $.complex_selector),
    // A descendant combinator is whitespace, so it separates compounds without a node.
    complex_selector: $ =>
      choice(
        seq(
          optional($._combinators),
          $._compound_selector,
          repeat1(seq($._combination, $._compound_selector)),
          optional($._combinators)
        ),
        seq($._combinators, $._compound_selector, optional($._combinators)),
        seq($._compound_selector, $._combinators),
        $._combinators
      ),
    // Sass still accepts consecutive and bare combinators, such as `.a >>> .b` and `> { … }`.
    _combinators: $ => repeat1($.combinator),
    _combination: $ => choice($._combinators, $._descendant, $._space_before_colon),
    _compound_selector: $ => choice($._simple_selector, $.compound_selector),
    compound_selector: $ =>
      choice(
        seq($._simple_selector, repeat1($._compound_tail)),
        seq($.namespace_selector, choice($.tag_selector, $.universal_selector), repeat($._compound_tail))
      ),
    _simple_selector: $ =>
      choice(
        $.tag_selector,
        $.universal_selector,
        $.parent_selector,
        $.keyframe_selector,
        $._subclass_selector,
        alias($._interpolated_pseudo_selector, $.pseudo_selector)
      ),
    // Sass reads a selector after evaluating it, so an interpolation touching `(` is a pseudo call: `#{$sel}(.a)`.
    _interpolated_pseudo_selector: $ => seq(alias($._interpolated_pseudo_name, $.pseudo_name), $.selector_arguments),
    _interpolated_pseudo_name: $ =>
      seq($.interpolation, optional(token.immediate(prec(1, NAME_FRAGMENT))), optional($._identifier_tail)),
    // Only an adjacent interpolation, as in `:not(.a)#{$b}`, extends the compound as a type-like
    // name. A name after whitespace needs the descendant token, so it cannot join from another statement.
    _compound_tail: $ =>
      choice(
        $._subclass_selector,
        prec.right(alias($._identifier_tail, $.tag_selector)),
        alias($._adjacent_pseudo_selector, $.pseudo_selector)
      ),
    _adjacent_pseudo_selector: $ => seq(alias($._identifier_tail, $.pseudo_name), $.selector_arguments),
    _subclass_selector: $ =>
      choice($.id_selector, $.class_selector, $.placeholder_selector, $.attribute_selector, $.pseudo_selector),
    tag_selector: $ => $._interpolated_identifier,
    id_selector: $ => seq("#", $._selector_name),
    class_selector: $ => seq(".", $._selector_name),
    placeholder_selector: $ => seq("%", $._selector_name),
    parent_selector: $ => prec.right(seq("&", optional(adjacentName($, token.immediate(prec(1, NAME_FRAGMENT)))))),
    universal_selector: () => prec(-1, "*"),
    namespace_selector: $ => seq(optional(choice(alias($._namespace_prefix, $.namespace_name), "*")), "|"),
    combinator: () => choice(">", "+", "~", "||"),
    keyframe_selector: $ => choice($.number, seq($.interpolation, token.immediate("%"))),
    attribute_selector: $ =>
      seq(
        "[",
        optional($.namespace_selector),
        alias($._interpolated_identifier, $.attribute_name),
        optional(
          seq(
            $.attribute_operator,
            choice($.string, $.plain_value),
            optional(alias($._identifier, $.attribute_modifier))
          )
        ),
        "]"
      ),
    attribute_operator: () => choice("=", "~=", "|=", "^=", "$=", "*="),
    pseudo_selector: $ =>
      choice(
        prec(
          1,
          seq(
            choice(":", "::"),
            alias($._value_pseudo_name, $.pseudo_name),
            alias($._pseudo_value_arguments, $.selector_arguments)
          )
        ),
        seq(
          ":",
          alias(token.immediate(choice(...NTH_PSEUDOS.map(name => keyword(name, true)))), $.pseudo_name),
          $.nth_arguments
        ),
        seq(choice(":", "::"), alias($._selector_name, $.pseudo_name), optional($.selector_arguments))
      ),
    nth_arguments: $ =>
      seq(
        token.immediate("("),
        choice(alias(choice(keyword("odd", true), keyword("even", true)), $.plain_value), $.nth_formula),
        optional(seq(alias(keyword("of", true), "of"), $.selectors)),
        ")"
      ),
    nth_formula: $ => repeat1(choice(/[+-]?(?:[0-9]*[nN]|[0-9]+)|[+-]/, $.interpolation)),
    selector_arguments: $ => seq(token.immediate("("), optional(choice($._selector_list, $.string)), ")"),
    _value_pseudo_name: () => token.immediate(choice(...VALUE_PSEUDOS.map(name => keyword(name, true)))),
    _pseudo_value_arguments: $ =>
      seq(token.immediate("("), repeat(choice($.plain_value, $.string, "*", ",", ".")), ")"),
    _selector_name: $ => adjacentName($, choice(token.immediate(IDENTIFIER), $._value_pseudo_name)),
    _interpolated_identifier: $ => interpolatedIdentifier($, choice(...identifierWords($)), "-"),
    _identifier_tail: $ =>
      repeat1(
        seq(alias($._adjacent_interpolation, $.interpolation), optional(token.immediate(prec(1, NAME_FRAGMENT))))
      ),
    interpolation: $ => seq("#{", $._value, "}"),
    // Only an adjacent interpolation continues a name; whitespace starts the next value or selector.
    _adjacent_interpolation: $ => seq(alias(token.immediate(prec(1, "#{")), "#{"), $._value, "}"),

    // Trivia comments never enter SassScript, even when their text contains `#{`.
    block_comment: $ =>
      seq(
        "/*",
        repeat(
          choice(
            alias(token.immediate(prec(1, /[^*#]+/)), $.comment_content),
            alias(token.immediate(choice("*", "#")), $.comment_content)
          )
        ),
        "*/"
      ),
    // Only statement positions offer this opener; content wins over extras, so nested openers stay literal.
    _statement_comment: $ =>
      seq(
        alias($._statement_comment_start, "/*"),
        repeat(
          choice(
            alias(token.immediate(prec(1, /[^*#]+/)), $.comment_content),
            alias(token.immediate(choice("*", "#")), $.comment_content),
            alias($._literal_comment_interpolation, $.comment_content),
            $.interpolation
          )
        ),
        "*/"
      ),
    inline_comment: () => token(seq("//", /[^\r\n]*/)),
    // Keep common numbers internally lexed for efficient incremental tree comparison.
    number: $ =>
      choice(
        $._scalar_number,
        seq(
          /-?(?:\d*\.\d+|\d+)(?:[eE][+-]?\d+)?/,
          optional(alias(token.immediate(prec(1, choice("%", SIMPLE_UNIT))), $.unit))
        ),
        seq($._dimension_number, alias($._dimension_unit, $.unit))
      ),
    string: $ => choice(quoted($, '"', /[^"\\#\r\n\f]+/), quoted($, "'", /[^'\\#\r\n\f]+/)),
    escape_sequence: () => token.immediate(ESCAPE),
    _value: $ => seq(commaSep1($._space_value), optional(",")),
    _space_value: $ => repeat1($._value_atom),
    // Sass subtracts on an unspaced minus after a number (`1-1`, `1px-2px`); elsewhere `-1` is one number.
    _number_subtraction: $ => seq($.number, alias($._subtraction_operator, $.operator)),
    _subtraction_operator: $ => alias($._subtraction_minus, "-"),
    // Share the productions themselves, not copies expanded into each context.
    _expression_atom: $ =>
      choice(
        $.number,
        $._number_subtraction,
        $.string,
        $.operator,
        $.hex_color,
        $.hash_value,
        $.variable_name,
        $.member_expression,
        $.interpolation,
        $.call_expression,
        $.url,
        $.special_call,
        $.conditional,
        $.boolean,
        $.null,
        $.plain_value,
        $.parent_selector,
        $.unicode_range,
        $.important,
        $.selector_query,
        $.dotted_value,
        $.spread
      ),
    _value_atom: $ => choice($._expression_atom, $.map, $.list),
    arguments: $ => argumentList(choice($._argument, alias($._equals_argument, $.argument))),
    // Each comma item is exactly one named child; a positional item of several atoms is an `argument`.
    _argument: $ => choice($.named_argument, $.feature_query, $._value_atom, $.argument),
    argument: $ => seq($._value_atom, repeat1($._value_atom)),
    // Sass keeps IE's alpha(opacity=50) form: a name, a single equals, and a value.
    _equals_argument: $ =>
      seq(
        choice(alias($._identifier, $.plain_value), alias($._wrapped_dashed_name, $.plain_value)),
        alias("=", $.operator),
        $._space_value
      ),
    _mixin_arguments: $ => argumentList($._argument, "("),
    named_argument: $ => seq(field("name", $.variable_name), ":", field("value", $._space_value)),
    call_expression: $ =>
      choice(
        functionCall($, $._css_var_function_name, alias($._css_var_arguments, $.arguments)),
        functionCall($, $._conditional_function_name),
        prec(1, functionCall($, $._math_function_name, alias($._calculation_arguments, $.arguments))),
        functionCall($, $.dashed_name),
        seq(
          optional(seq(field("module", moduleName($)), token.immediate("."))),
          field("name", alias($._interpolated_identifier, $.function_name)),
          field("arguments", $.arguments)
        )
      ),
    _css_var_arguments: $ =>
      seq(
        token.immediate("("),
        optional(choice($._value_atom, $.argument)),
        optional(seq(",", optional(choice($._css_fallback_item, alias($._css_fallback, $.argument))))),
        ")"
      ),
    // Everything after the first comma, commas included, is one fallback argument.
    _css_fallback: $ => seq($._css_fallback_item, repeat1($._css_fallback_item)),
    _css_fallback_item: $ =>
      choice(
        $._value_atom,
        alias($._css_fallback_group, $.raw_group),
        alias($._css_fallback_call, $.call_expression),
        ",",
        ":",
        alias(token(prec(-1, /[^\s()\[\]{};,!"']/)), $.raw_text)
      ),
    _css_fallback_group: $ =>
      rawFallback(
        choice(
          seq("(", fallbackContent($), ")"),
          seq("[", fallbackContent($), "]"),
          seq("{", fallbackContent($), "}"),
          seq(alias($._literal_raw_interpolation, $.raw_text), rawContent($), "}")
        )
      ),
    // Like raw fallback groups, a raw call applies only when an ordinary call cannot parse.
    _css_fallback_call: $ =>
      rawFallback(
        choice(
          functionCall($, $._interpolated_identifier, alias($._css_fallback_arguments, $.raw_group)),
          functionCall($, $.dashed_name, alias($._css_fallback_arguments, $.raw_group))
        )
      ),
    _css_fallback_arguments: $ => prec(-1, seq(token.immediate("("), fallbackContent($), ")")),
    // Earlier rules win equal-length identifier ties. Equal lexical precedence
    // still lets a longer identifier keep its specialized-looking prefix.
    // One token per name group: identifier positions accept these names, so per-name tokens widen every state.
    _math_function_name: () => token(choice(...MATH_FUNCTIONS.map(name => keyword(name, true)))),
    _selector_function_name: () => keyword("selector", true),
    _type_function_name: () => keyword("type", true),
    _query_function_name: () =>
      token(choice(...["style", "scroll-state", "supports", "media", "at-rule"].map(name => keyword(name, true)))),
    _raw_function_word: () => token(choice(...RAW_FUNCTION_NAMES)),
    _sass_conditional_function_name: () => /if/,
    _conditional_function_name: () => keyword("if", true),
    _else_keyword: () => keyword("else", true),
    _result_property_name: () => keyword("result", true),
    _calculation_arguments: $ =>
      argumentList(
        choice($.named_argument, $.feature_query, $._calculation_atom, alias($._calculation_argument, $.argument))
      ),
    _calculation_argument: $ => seq($._calculation_atom, repeat1($._calculation_atom)),
    _calculation_atom: $ =>
      choice($._expression_atom, $.map, alias($._calculation_group, $.list), $.calculation_constant),
    _calculation_group: $ =>
      prec(
        1,
        choice(
          seq("(", optional(seq(commaSep1(repeat1($._calculation_atom)), optional(","))), ")"),
          seq("[", optional($._value), "]")
        )
      ),
    calculation_constant: $ => $._calculation_constant,
    member_expression: $ => seq(field("module", moduleName($)), token.immediate("."), field("name", $.variable_name)),
    list: $ => choice(seq("(", optional($._value), ")"), seq("[", optional($._value), "]")),
    map: $ => seq("(", commaSep1($.map_entry), optional(","), ")"),
    map_entry: $ => seq(field("key", $._space_value), ":", field("value", $._space_value)),
    spread: () => "...",
    operator: $ => choice("+", "-", "*", "/", "%", "==", "!=", "<", "<=", ">", ">=", $._sass_operator),
    // The scanner never emits _missing_variable_name: recovery inserts it for
    // a bare prefix. Reusing IDENTIFIER here could join a name across extras.
    variable_name: $ =>
      choice(
        token(seq("$", IDENTIFIER)),
        seq(alias($._incomplete_variable_prefix, "$"), alias($._missing_variable_name, "identifier"))
      ),
    boolean: $ => $._sass_boolean,
    null: $ => $._sass_null,
    hex_color: () => token(seq("#", /(?:[0-9a-fA-F]{8}|[0-9a-fA-F]{6}|[0-9a-fA-F]{4}|[0-9a-fA-F]{3})/)),
    hash_value: () => token(seq("#", NAME_FRAGMENT)),
    unicode_range: () => /[uU]\+[0-9a-fA-F?]{1,6}(?:-[0-9a-fA-F]{1,6})?/,
    // Module references share this immediate dot, so a spaced `.class` cannot extend a value word.
    dotted_value: $ => seq(choice($._identifier, $._dashed_name), repeat1(seq(token.immediate("."), $._identifier))),
    plain_value: $ => choice($._interpolated_identifier, $.dashed_name, $._special_call_word),
    // Special-call names are ordinary words unless their literal call syntax follows.
    _special_call_word: $ => prec.right(seq(choice(URL_NAME, $._raw_function_word), optional($._identifier_tail))),
    flag: () => /![ \t]*[-\w]+/,
    important: () => /![ \t]*[iI][mM][pP][oO][rR][tT][aA][nN][tT]/,
    // Reused query words must also reduce as identifiers after an enclosing call changes.
    // Prefer their operator role only where a query condition accepts it.
    _query_operator: $ => prec(1, choice("=", $._query_word_operator)),
    _query_word_operator: () => token(choice(...["not", "or", "and", "only"].map(name => keyword(name, true)))),
    _identifier: () => IDENTIFIER,

    // Raw CSS only enters SassScript through interpolation. Its CSS tokens keep typed
    // nodes, but no raw token is a Sass variable, boolean, null, or evaluated operation.
    raw_value: $ => repeat1($._raw_item),
    _raw_item: $ => choice($.raw_text, $._raw_token, $.raw_group),
    _raw_token: $ =>
      choice(
        $.number,
        $.string,
        $.hex_color,
        $.hash_value,
        $.unicode_range,
        $.interpolation,
        $.plain_value,
        alias($._raw_call, $.call_expression),
        alias(choice("+", "-", "*", "/", "=", "<", "<=", ">", ">="), $.operator),
        ",",
        ":"
      ),
    _raw_call: $ =>
      choice(
        functionCall($, $._raw_function_name, alias($._raw_arguments, $.raw_group)),
        functionCall($, $.dashed_name, alias($._raw_arguments, $.raw_group))
      ),
    _raw_function_name: $ => choice($._interpolated_identifier, $._special_call_word),
    _raw_arguments: $ => seq(token.immediate("("), rawContent($), ")"),
    // Unlike an at-rule prelude, a raw declaration value keeps `//` as text.
    raw_text: $ => choice(token(prec(2, /\/\/[^\r\n;{}()\[\]"'\\#!]*/)), $._raw_word),
    _raw_word: () => token(RAW_WORD),
    _prelude_group: $ => choice(seq("(", rawContent($), ")"), seq("[", rawContent($), "]")),
    raw_group: $ =>
      choice($._prelude_group, seq(choice("{", alias($._literal_raw_interpolation, $.raw_text)), rawContent($), "}")),
    url: $ =>
      seq(
        alias(URL_NAME, $.function_name),
        token.immediate("("),
        optional(
          choice(
            seq(choice($.variable_name, $.string, alias($._url_call, $.call_expression)), repeat($._value_atom)),
            $.url_value
          )
        ),
        ")"
      ),
    // Sass reparses url() as a function call once its contents are not a literal URL.
    _url_call: $ => functionCall($, URL_WORD),
    url_value: $ =>
      repeat1(
        choice(
          alias($._literal_css_url, $.raw_text),
          alias(URL_WORD, $.raw_text),
          alias(token.immediate("#"), $.raw_text),
          $.escape_sequence,
          $.interpolation
        )
      ),
    special_call: $ =>
      seq(
        alias(choice($._raw_function_word, /-[a-z]+-calc/, /progid:[a-zA-Z.]+/), $.function_name),
        token.immediate("("),
        optional($.raw_value),
        ")"
      ),
    conditional: $ =>
      choice(
        seq(
          alias($._sass_conditional_function_name, $.function_name),
          token.immediate("("),
          choice(
            seq(commaSep1(choice($._value_atom, $.argument, $.named_argument)), optional(",")),
            seq(sep1($.conditional_branch, ";"), optional(";"))
          ),
          ")"
        ),
        seq(
          alias($._conditional_function_name, $.function_name),
          token.immediate("("),
          sep1($.conditional_branch, ";"),
          optional(";"),
          ")"
        )
      ),
    conditional_branch: $ =>
      seq(
        field("condition", choice($._query_value, prec(1, alias($._else_keyword, "else")))),
        ":",
        optional(field("value", $._value))
      ),

    _at_rule: $ => choice(...atRules($, $.query_statement)),
    // Final statements may omit their semicolon. Property endings stay local
    // to each block context, while these endings also apply to the stylesheet.
    _final_statement: $ =>
      choice(
        alias($._variable, $.variable_declaration),
        alias($._use_head, $.use_statement),
        alias($._forward_head, $.forward_statement),
        alias($._include_head, $.include_statement),
        alias($._content_head, $.content_statement),
        alias($._value_head, $.value_statement),
        alias($._extend_head, $.extend_statement),
        alias($._namespace_head, $.namespace_statement),
        alias($._css_statement_head, $.css_statement),
        alias($._query_head, $.query_statement),
        alias($._at_rule_head, $.at_rule)
      ),
    use_statement: $ => seq($._use_head, ";"),
    _use_head: $ =>
      seq(
        directive("use"),
        $.string,
        optional(seq("as", field("alias", choice(moduleName($), "*")))),
        optional($.configuration)
      ),
    forward_statement: $ => seq($._forward_head, ";"),
    _forward_head: $ =>
      seq(
        directive("forward"),
        $.string,
        optional(seq("as", moduleName($), "*")),
        optional(
          seq(choice("show", "hide"), commaSep1(choice($.variable_name, alias($._identifier, $.function_name))))
        ),
        optional($.configuration)
      ),
    configuration: $ => seq("with", "(", commaSep1(seq($.named_argument, optional($.flag))), optional(","), ")"),
    function_definition: $ =>
      choice(
        functionDefinition($, $._dashed_name, $._css_function_block),
        functionDefinition($, $._identifier, $._block)
      ),
    _css_function_block: $ => braced(alias($._css_function_body, $.declaration_block)),
    _css_function_body: $ =>
      declarationBlock(
        $,
        choice(
          $.rule_set,
          $.variable_declaration,
          alias($._css_function_property_declaration, $.property_declaration),
          ...atRules($, alias($._css_function_query, $.query_statement)),
          ";"
        ),
        $._css_function_property
      ),
    _css_function_property_declaration: $ => choice(seq($._css_function_property, ";"), $._nested_property),
    _css_function_property: $ => choice($._property, prec(1, rawProperty($, $._result_property_name))),
    _css_function_query: $ => seq($._query_head, choice(";", $._css_function_block)),
    mixin_definition: $ =>
      seq(
        directive("mixin"),
        field("name", alias($._identifier, $.function_name)),
        optional(field("parameters", $.parameters)),
        $._block
      ),
    parameters: $ => argumentList($.parameter, "("),
    parameter: $ =>
      prec(
        1,
        seq(
          field("name", choice($.variable_name, alias($._dashed_name, $.parameter_name))),
          optional($.type_annotation),
          optional(seq(":", field("value", $._space_value))),
          optional($.spread)
        )
      ),
    type_annotation: $ =>
      choice(
        $._type_component,
        seq(
          alias($._type_function_name, $.function_name),
          token.immediate("("),
          choice("*", sep1($._type_component, "|")),
          ")"
        )
      ),
    _type_component: $ =>
      seq(
        choice(
          seq("<", alias($._identifier, $.type_name), ">"),
          alias(choice($._identifier, $._type_function_name), $.type_name)
        ),
        optional(alias(choice("+", "#"), $.operator))
      ),
    include_statement: $ => seq($._include_head, choice(";", $._block)),
    _include_head: $ =>
      seq(
        directive("include"),
        optional(seq(field("module", moduleName($)), token.immediate("."))),
        field("name", alias(keywordShapedName($), $.function_name)),
        optional(field("arguments", alias($._mixin_arguments, $.arguments))),
        optional(seq("using", field("parameters", $.parameters)))
      ),
    content_statement: $ => seq($._content_head, ";"),
    _content_head: $ => seq(directive("content"), optional(alias($._mixin_arguments, $.arguments))),
    // Retain else lookahead, but allow an unfinished branch to recover inside its enclosing block.
    if_statement: $ =>
      prec.right(
        seq(directive("if"), field("condition", $._value), $._block, repeat($.else_clause), optional($._if_end))
      ),
    else_clause: $ =>
      seq(
        choice(
          seq(directive("else"), optional(seq("if", field("condition", $._value)))),
          // Sass still accepts the deprecated @elseif spelling.
          seq(directive("elseif"), field("condition", $._value))
        ),
        $._block
      ),
    each_statement: $ => seq(directive("each"), commaSep1($.variable_name), "in", $._value, $._block),
    for_statement: $ =>
      seq(directive("for"), $.variable_name, "from", $._space_value, choice("to", "through"), $._space_value, $._block),
    while_statement: $ => seq(directive("while"), field("condition", $._value), $._block),
    value_statement: $ => seq($._value_head, ";"),
    _value_head: $ =>
      seq(choice(directive("return"), directive("debug"), directive("warn"), directive("error")), $._value),
    extend_statement: $ => seq($._extend_head, ";"),
    _extend_head: $ => seq(directive("extend"), $.selectors, optional($.flag)),
    at_root_statement: $ => seq(directive("at-root"), optional(choice($.selectors, $.map)), $._block),

    // Query grouping is not a Sass list/map. Expressions inside calls and
    // declarations retain their ordinary value containers and raw boundaries.
    query_statement: $ => seq($._query_head, choice(";", $._block)),
    _query_head: $ =>
      choice(
        // A stray block recovers as a missing selector or bare `@media` at equal cost; prefer the selector.
        prec.dynamic(-1, directive("media")),
        seq(directive("media"), field("prelude", $._query_value)),
        seq(
          choice(directive("supports"), directive("container"), directive("import")),
          field("prelude", $._query_value)
        )
      ),
    _query_value: $ => seq(commaSep1(repeat1($._query_atom)), optional(",")),
    _query_atom: $ =>
      choice(
        $._expression_atom,
        alias($._query_operator, $.operator),
        $.query_group,
        alias($._query_call, $.call_expression)
      ),
    query_group: $ => seq("(", optional($._query_condition), ")"),
    // A query function's body is the same condition as a parenthesized query group; `at-rule()` names an at-keyword.
    _query_call: $ => prec(1, functionCall($, $._query_function_name, alias($._query_call_group, $.query_group))),
    _query_call_group: $ => seq(token.immediate("("), optional(choice($._query_condition, $.at_keyword)), ")"),
    _query_condition: $ => choice(alias($._property, $.feature_query), $._query_value),
    feature_query: $ =>
      prec(
        1,
        seq(
          field(
            "name",
            choice(alias($._interpolated_identifier, $.property_name), alias($._wrapped_dashed_name, $.property_name))
          ),
          ":",
          field("value", $._space_value)
        )
      ),
    selector_query: $ =>
      prec(1, seq(alias($._selector_function_name, $.function_name), token.immediate("("), $.selectors, ")")),
    scope_statement: $ =>
      seq(
        directive("scope"),
        optional(seq("(", $.selectors, ")")),
        optional(seq(alias(keyword("to", true), "to"), "(", $.selectors, ")")),
        $._block
      ),
    keyframes_statement: $ =>
      seq(
        choice(...KEYFRAMES_DIRECTIVES.map(directive)),
        choice(alias($._interpolated_identifier, $.keyframes_name), $.string),
        $._block
      ),
    namespace_statement: $ => seq($._namespace_head, ";"),
    _namespace_head: $ =>
      seq(
        directive("namespace"),
        optional(alias(choice(...identifierWords($), URL_NAME), $.namespace_name)),
        choice($.string, $.url)
      ),
    css_statement: $ => seq($._css_statement_head, choice(";", $._block)),
    _css_statement_head: $ => seq(choice(...CSS_STATEMENTS.map(directive)), optional(field("prelude", $._value))),
    page_statement: $ => seq(directive("page"), optional($.selectors), $._block),
    at_rule: $ => seq($._at_rule_head, choice(";", $._unknown_block)),
    _at_rule_head: $ =>
      seq(
        $.at_keyword,
        // An at-rule prelude reads `//` as a silent comment, as Sass does.
        repeat(
          field("prelude", choice(alias($._raw_word, $.raw_text), $._raw_token, alias($._prelude_group, $.raw_group)))
        )
      ),
    _unknown_block: $ => braced(alias($._unknown_declaration_block, $.declaration_block)),
    _unknown_declaration_block: $ => declarationBlock($, choice($._statement, $.raw_statement)),
    // Limit fallback to unknown at-rule bodies. A top-level raw [] group would
    // steal attribute-selector tokens before the parser sees their rule block.
    raw_statement: $ =>
      prec.dynamic(
        -1,
        // The competing selector reading lexes whitespace between items as a descendant.
        seq(
          $._raw_statement_item,
          repeat(
            seq(optional(choice($._descendant, $._space_before_colon, $._statement_break)), $._raw_statement_item)
          ),
          ";"
        )
      ),
    _raw_statement_item: $ =>
      choice(
        alias($._interpolated_identifier, $.plain_value),
        $.string,
        alias($._unknown_statement_group, $.raw_group)
      ),
    // An interpolated pseudo call claims an adjacent `(` before the raw reading splits off, so accept it here too.
    _unknown_statement_group: $ => seq(choice("(", alias(token.immediate("("), "(")), rawContent($), ")"),
    at_keyword: $ =>
      prec.right(
        seq(
          choice(token(seq("@", IDENTIFIER)), seq("@", alias($._adjacent_interpolation, $.interpolation))),
          optional($._identifier_tail)
        )
      )
  }
});

// Direct braces define the complete block; body only groups its statements and loud comments.
function braced(body) {
  return seq("{", optional(field("body", body)), "}");
}

function declarationBlock($, statement, property = $._property) {
  const item = choice(statement, alias($._statement_comment, $.block_comment), $._statement_break);
  return choice(repeat1(item), seq(repeat(item), choice(alias(property, $.property_declaration), $._final_statement)));
}

// Raw values keep balanced text; only a trailing priority leaves the payload.
function rawProperty($, name) {
  return seq(
    field("name", alias(name, $.property_name)),
    optional($._space_before_colon),
    ":",
    optional(field("value", $.raw_value)),
    optional(field("flags", alias($._declaration_priority, $.important)))
  );
}

function functionCall($, name, args = $.arguments) {
  return seq(field("name", alias(name, $.function_name)), field("arguments", args));
}

function functionDefinition($, name, block) {
  return seq(
    directive("function"),
    field("name", alias(name, $.function_name)),
    field("parameters", $.parameters),
    optional(seq(alias(keyword("returns", true), "returns"), $.type_annotation)),
    block
  );
}

function atRules($, query) {
  return [
    $.use_statement,
    $.forward_statement,
    $.function_definition,
    $.mixin_definition,
    $.include_statement,
    $.content_statement,
    $.if_statement,
    $.each_statement,
    $.for_statement,
    $.while_statement,
    $.value_statement,
    $.extend_statement,
    $.at_root_statement,
    $.keyframes_statement,
    $.namespace_statement,
    $.css_statement,
    $.page_statement,
    query,
    $.scope_statement,
    $.at_rule
  ];
}

function sep1(rule, separator) {
  return seq(rule, repeat(seq(separator, rule)));
}
function commaSep1(rule) {
  return sep1(rule, ",");
}
function argumentList(rule, open = token.immediate("(")) {
  return seq(open, optional(commaSep1(rule)), optional(","), ")");
}
function rawContent($) {
  return repeat(choice($._raw_item, ";"));
}
function fallbackContent($) {
  return repeat(choice($._css_fallback_item, ";", alias("!", $.raw_text)));
}
function rawFallback(rule) {
  return prec.dynamic(-1, prec(-1, rule));
}
function quoted($, quote, content) {
  return seq(
    quote,
    repeat(
      choice(
        alias(token.immediate(prec(1, content)), $.string_content),
        alias(token.immediate("#"), $.string_content),
        alias(quote === '"' ? $._literal_double_interpolation : $._literal_single_interpolation, $.string_content),
        alias(token.immediate(choice(ESCAPE, /\\(?:\r\n?|\n|\f)/)), $.escape_sequence),
        $.interpolation
      )
    ),
    token.immediate(quote)
  );
}
function interpolatedIdentifier($, identifier, hyphen, leading = $.interpolation) {
  return prec.right(
    seq(
      choice(
        identifier,
        seq(
          hyphen,
          alias($._adjacent_interpolation, $.interpolation),
          optional(token.immediate(prec(1, NAME_FRAGMENT)))
        ),
        seq(leading, optional(token.immediate(prec(1, NAME_FRAGMENT))))
      ),
      optional($._identifier_tail)
    )
  );
}
// A selector name continues the preceding token, so none of its parts may follow whitespace.
function adjacentName($, identifier) {
  return interpolatedIdentifier($, identifier, token.immediate("-"), alias($._adjacent_interpolation, $.interpolation));
}
// Keep keywords in Tree-sitter's compact keyword lexer. Escaped spellings
// remain ordinary identifiers instead of expanding every keyword into a DFA.
function keyword(word, ignoreCase = false) {
  return new RegExp(ignoreCase ? word.replace(/[a-z]/g, letter => `[${letter}${letter.toUpperCase()}]`) : word);
}

function directive(name) {
  return alias(token(seq("@", keyword(name, CSS_DIRECTIVES.has(name)))), `@${name}`);
}

function moduleName($) {
  // Reuse value tokens: keyword-shaped names become modules before a dot.
  return alias(keywordShapedName($), $.module_name);
}

// An optional module prefix makes value keywords and `--` names lexable, so the name after it must accept them.
function keywordShapedName($) {
  return choice(
    ...identifierWords($),
    $._dashed_name,
    $.boolean,
    $.null,
    $._sass_operator,
    $._raw_function_word,
    URL_NAME
  );
}

// Specialized names win equal-length ties with `_identifier`, so every identifier position accepts them too.
function identifierWords($) {
  return [
    $._identifier,
    $._math_function_name,
    $._query_function_name,
    $._query_word_operator,
    $._selector_function_name,
    $._sass_conditional_function_name,
    $._conditional_function_name,
    $._else_keyword,
    $._result_property_name
  ];
}
