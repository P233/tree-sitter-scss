(block_comment) @comment
(inline_comment) @comment

(tag_selector) @tag
(id_selector) @attribute
(class_selector) @attribute
(property_name) @property
(variable_name) @variable
(module_name) @module
(function_name) @function

(plain_value) @constant
(number) @number
(unit) @type
(hex_color) @constant
(boolean) @constant.builtin
(null) @constant.builtin
(flag) @keyword
(operator) @operator

(string) @string
(escape_sequence) @string.escape

["{" "}" "(" ")" "[" "]"] @punctuation.bracket
[":" ";" "," "."] @punctuation.delimiter
(interpolation ["#{" "}"] @punctuation.special)
