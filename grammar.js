module.exports = grammar({
  name: "scss",

  extras: $ => [/\s/, $.block_comment, $.inline_comment],

  conflicts: $ => [
    [$.list, $.map],
    [$.property_declaration, $.operator]
  ],

  rules: {
    // --------------------------------------------
    // Root
    // --------------------------------------------

    stylesheet: $ => repeat(choice($.rule_set, $.variable_declaration)),

    // --------------------------------------------
    // At-rule statements
    // --------------------------------------------

    // root at-rules

    // nestable at-rules

    // --------------------------------------------
    // Integrated combinations
    // --------------------------------------------

    rule_set: $ => seq($.selectors, "{", optional($.declaration_block), "}"),

    declaration_block: $ => {
      return repeat1(choice($.property_declaration, $.variable_declaration, $.rule_set));
    },

    variable_declaration: $ => {
      return seq($.variable_name, ":", $._variable_value, optional($.flag), ";");
    },

    // --------------------------------------------
    // Selectors
    // --------------------------------------------

    tag_selector: () => /[a-z]+/,

    id_selector: $ => seq(/#[a-zA-Z]/, repeat1(choice(/[\w-]/, $.interpolation))),

    class_selector: $ => seq(/\.[a-zA-Z]/, repeat1(choice(/[\w-]/, $.interpolation))),

    selectors: $ => {
      return repeat1(choice($.tag_selector, $.id_selector, $.class_selector));
    },

    // --------------------------------------------
    // Fundamental combinations
    // --------------------------------------------

    interpolation: $ => seq("#{", $._interpolation_value, "}"),

    block_comment: $ => seq("/*", repeat(choice(/./, $.interpolation)), "*/"),

    number: $ => seq(/-?\d*\.?\d+/, optional(alias(/[a-zA-Z%]+/, $.unit))),

    string: $ => {
      return choice(
        seq("'", repeat(choice(/./, $.interpolation)), "'"),
        seq('"', repeat(choice(/./, $.interpolation)), '"')
      );
    },

    parameters: $ => {
      return seq(
        "(",
        repeat1(seq($.variable_name, optional(":"), optional($._variable_value), optional(","))),
        optional(seq($.variable_name, "...")),
        ")"
      );
    },

    arguments: $ => seq("(", repeat1($._variable_value), optional(seq($.variable_name, "...")), ")"),

    call_expression: $ => {
      return seq(
        optional(seq(alias(/[a-zA-Z][\w-]+/, $.module_name), alias(".", $.module_dot))),
        alias(/[a-zA-Z][\w-]+/, $.function_name),
        $.arguments
      );
    },

    property_declaration: $ => {
      return seq(
        alias(repeat1(choice(/[\w-]/, $.interpolation)), $.property_name),
        ":",
        $._property_value,
        optional($.flag),
        ";"
      );
    },

    list: $ => {
      return choice(
        seq("(", repeat(seq($._list_value, optional(","))), ")"),
        seq("[", repeat(seq($._list_value, optional(","))), "]")
      );
    },

    map: $ => {
      return seq("(", repeat($.map_entry), ")");
    },

    map_entry: $ => {
      return seq(
        alias(repeat1(choice(/[\w-]/, $.interpolation)), $.map_key),
        ":",
        choice($.map, repeat($._map_value)),
        optional(",")
      );
    },

    // --------------------------------------------
    // Value helpers
    // --------------------------------------------

    _interpolation_value: $ => {
      return repeat1(choice($.number, $.string, $.operator, $.variable_name, $.call_expression));
    },

    _property_value: $ => {
      return repeat1(
        choice(
          $.number,
          $.string,
          $.operator,
          $.hex_color,
          $.variable_name,
          $.interpolation,
          $.call_expression,
          $.plain_value
        )
      );
    },

    _variable_value: $ => {
      return repeat1(
        choice(
          $.number,
          $.string,
          $.operator,
          $.hex_color,
          $.map,
          // $.list,
          $.variable_name,
          $.interpolation,
          $.call_expression,
          $.plain_value
        )
      );
    },

    _list_value: $ => {
      return choice(
        $.number,
        $.string,
        $.operator,
        $.hex_color,
        // $.list,
        $.variable_name,
        // $.interpolation,
        $.call_expression,
        $.plain_value
      );
    },

    _map_value: $ => {
      return choice(
        $.number,
        $.string,
        $.operator,
        $.hex_color,
        // $.list,
        $.variable_name,
        // $.interpolation,
        $.call_expression,
        $.plain_value
      );
    },

    // --------------------------------------------
    // Essential elements
    // --------------------------------------------

    inline_comment: () => seq("//", /.*/),

    operator: () => choice("+", "-", "*", "/", "%", "==", "!=", "<", "<=", ">", ">=", "not", "or", "and"),

    variable_name: () => seq("$", /\w+/),

    boolean: () => choice("true", "false"),

    hex_color: () => seq("#", /[0-9a-fA-F]{3,8}/),

    plain_value: () => /[a-zA-Z_-][\w-]*/,

    flag: () => /!\w+/
  }
});
