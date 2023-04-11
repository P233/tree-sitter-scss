module.exports = grammar({
  name: "scss",

  extras: $ => [/\s/, $.block_comment, $.inline_comment],

  rules: {
    // --------------------------------------------
    // Root
    // --------------------------------------------

    stylesheet: $ => repeat(choice($.variable_declaration)),

    // --------------------------------------------
    // At-rule statements
    // --------------------------------------------

    // root at-rules

    // nestable at-rules

    // --------------------------------------------
    // Integrated combinations
    // --------------------------------------------

    // rule_set: $ => seq($.selectors, optional(seq("{", optional($.declaration_block), "}"))),

    // declaration_block: $ => {
    //   return repeat1(choice($.property_declaration));
    // },

    variable_declaration: $ => {
      return seq(
        $.variable_name,
        $.delimiter,
        optional(choice($._variable_value, $.sass_map)),
        optional($.flag),
        $.terminator
      );
    },

    // --------------------------------------------
    // Selectors
    // --------------------------------------------

    // id_selector: $ => seq(/#[a-zA-Z]/, repeat1(choice(/[\w-]/, $.interpolation))),

    // class_selector: $ => seq(/\.[a-zA-Z]/, repeat1(choice(/[\w-]/, $.interpolation))),

    // selectors: $ => {
    //   return prec.left(2, repeat1(choice($.id_selector, $.class_selector)));
    // },

    // --------------------------------------------
    // Fundamental combinations
    // --------------------------------------------

    interpolation: $ => {
      return seq(
        alias("#{", $.interpolation_bracket),
        optional($._interpolation_value),
        alias("}", $.interpolation_bracket)
      );
    },

    block_comment: $ => seq("/*", repeat(choice(/./, $.interpolation)), "*/"),

    number: $ => {
      return seq(/-?\d*\.?\d+/, optional(alias(/[a-zA-Z%]+/, $.unit)));
    },

    string: $ => {
      return choice(
        seq("'", repeat(choice(/./, $.interpolation)), "'"),
        seq('"', repeat(choice(/./, $.interpolation)), '"')
      );
    },

    sass_list: $ => {
      return choice(seq("(", optional($._sass_list_value), ")"), seq("[", optional($._sass_list_value), "]"));
    },

    // parameters: $ => seq(),

    arguments: $ => "1",

    call_expression: $ => {
      return seq(
        optional(seq(alias(/[a-zA-Z][\w-]+/, $.module_name), alias(".", $.module_dot))),
        alias(/[a-zA-Z][\w-]+/, $.function_name),
        alias("(", $.function_paren),
        $.arguments,
        alias(")", $.function_paren)
      );
    },

    property_declaration: $ => {
      return seq(
        alias(repeat1(choice(/[\w-]/, $.interpolation)), $.property_name),
        $.delimiter,
        optional($._property_value),
        optional($.flag),
        $.terminator
      );
    },

    sass_map: $ => {
      return seq("(", repeat1($.sass_map_entry), ")");
    },

    sass_map_entry: $ => {
      return seq(
        alias(repeat1(choice(/[\w-]/, $.interpolation)), $.sass_map_key),
        $.delimiter,
        choice($._sass_map_value, $.sass_map),
        optional($.comma)
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
          $.hex_color,
          $.variable_name,
          // $.interpolation,
          $.call_expression,
          $.plain_value,
          $.comma,
          $.slash
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
          $.sass_list,
          $.variable_name,
          // $.interpolation,
          $.call_expression,
          $.plain_value,
          $.comma
        )
      );
    },

    _sass_map_value: $ => {
      return repeat1(
        choice(
          $.number,
          $.string,
          $.operator,
          $.hex_color,
          $.sass_list,
          $.variable_name,
          // $.interpolation,
          $.call_expression,
          $.plain_value
        )
      );
    },

    _sass_list_value: $ => {
      return repeat1(
        choice(
          $.number,
          $.string,
          $.operator,
          $.hex_color,
          $.sass_map,
          $.sass_list,
          $.variable_name,
          // $.interpolation,
          $.call_expression,
          $.plain_value,
          $.comma
        )
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

    flag: () => /!\w+/,

    comma: () => ",",

    slash: () => "/",

    delimiter: () => ":",

    terminator: () => ";"
  }
});
