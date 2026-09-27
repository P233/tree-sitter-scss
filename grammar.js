const IDENTIFIER = /[-_a-zA-Z][-_a-zA-Z0-9]*/;

module.exports = grammar({
  name: "scss",

  extras: $ => [/\s/, $.block_comment, $.inline_comment],
  word: $ => $._identifier,

  rules: {
    stylesheet: $ => repeat(choice($.rule_set, $.variable_declaration)),

    rule_set: $ => seq($.selectors, "{", optional($.declaration_block), "}"),
    declaration_block: $ => repeat1(choice($.property_declaration, $.variable_declaration, $.rule_set)),

    variable_declaration: $ => seq(field("name", $.variable_name), ":", $._value, repeat($.flag), ";"),

    property_declaration: $ => seq(field("name", $.property_name), ":", $._value, optional($.flag), ";"),
    property_name: $ => $._interpolated_identifier,

    selectors: $ => commaSep1(repeat1(choice($.tag_selector, $.id_selector, $.class_selector))),
    tag_selector: $ => $._identifier,
    id_selector: $ => seq("#", $._selector_name),
    class_selector: $ => seq(".", $._selector_name),
    _selector_name: $ =>
      seq(token.immediate(IDENTIFIER), repeat(seq($.interpolation, optional(token.immediate(IDENTIFIER))))),
    _interpolated_identifier: $ =>
      choice(
        seq($._identifier, repeat(seq($.interpolation, optional(token.immediate(IDENTIFIER))))),
        seq($.interpolation, repeat(choice(token.immediate(IDENTIFIER), $.interpolation)))
      ),

    interpolation: $ => seq("#{", $._value, "}"),

    // Comments are lexical tokens: extras must not recursively enter their bodies.
    block_comment: () => token(seq("/*", /[^*]*\*+([^/*][^*]*\*+)*/, "/")),
    inline_comment: () => token(seq("//", /[^\r\n]*/)),

    number: $ => seq(/[+-]?(?:\d*\.\d+|\d+)(?:[eE][+-]?\d+)?/, optional(alias(token.immediate(/[a-zA-Z%]+/), $.unit))),
    string: $ =>
      choice(
        seq(
          '"',
          repeat(
            choice(
              alias(token.immediate(prec(1, /[^"\\#\r\n]+/)), $.string_content),
              alias(token.immediate("#"), $.string_content),
              $.escape_sequence,
              $.interpolation
            )
          ),
          token.immediate('"')
        ),
        seq(
          "'",
          repeat(
            choice(
              alias(token.immediate(prec(1, /[^'\\#\r\n]+/)), $.string_content),
              alias(token.immediate("#"), $.string_content),
              $.escape_sequence,
              $.interpolation
            )
          ),
          token.immediate("'")
        )
      ),
    escape_sequence: () => token.immediate(seq("\\", choice(/[^\r\n]/, /\r?\n/))),

    arguments: $ =>
      seq(token.immediate("("), optional(commaSep1(choice($.named_argument, $._space_value))), optional(","), ")"),
    named_argument: $ => seq(field("name", $.variable_name), ":", $._space_value),
    call_expression: $ =>
      seq(
        optional(seq(alias($._identifier, $.module_name), ".")),
        field("name", alias($._identifier, $.function_name)),
        field("arguments", $.arguments)
      ),

    list: $ => choice(seq("(", optional($._value), ")"), seq("[", optional($._value), "]")),
    map: $ => seq("(", commaSep1($.map_entry), optional(","), ")"),
    map_entry: $ => seq(field("key", $._space_value), ":", field("value", $._space_value)),

    _value: $ => seq(commaSep1($._space_value), optional(",")),
    _space_value: $ => repeat1($._value_atom),
    _value_atom: $ =>
      choice(
        $.number,
        $.string,
        $.operator,
        $.hex_color,
        $.map,
        $.list,
        $.variable_name,
        $.interpolation,
        $.call_expression,
        $.boolean,
        $.null,
        $.plain_value
      ),

    operator: () => choice("+", "-", "*", "/", "%", "==", "!=", "<", "<=", ">", ">=", "not", "or", "and"),
    variable_name: () => token(seq("$", IDENTIFIER)),
    boolean: () => choice("true", "false"),
    null: () => "null",
    hex_color: () => token(seq("#", /(?:[0-9a-fA-F]{8}|[0-9a-fA-F]{6}|[0-9a-fA-F]{4}|[0-9a-fA-F]{3})/)),
    plain_value: $ => $._identifier,
    flag: () => /![-\w]+/,
    _identifier: () => IDENTIFIER
  }
});

function commaSep1(rule) {
  return seq(rule, repeat(seq(",", rule)));
}
