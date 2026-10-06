[(block_comment) (inline_comment) "<!--" "-->"] @comment

[(tag_selector) (parent_selector) (universal_selector)] @tag
[(id_selector) (class_selector) (placeholder_selector) (attribute_name) (pseudo_name)] @attribute
(property_name) @property
[(variable_name) (parameter_name)] @variable
[(module_name) (namespace_name)] @module
(function_name) @function

[(plain_value) (dotted_value) (hash_value) (hex_color) (unicode_range) (keyframes_name)] @constant
[(number) (nth_formula)] @number
(unit) @type.unit
(type_name) @type
[(boolean) (null) (calculation_constant)] @constant.builtin
[(flag) (important)] @keyword.modifier
(at_keyword) @keyword.directive
(attribute_modifier) @keyword
(operator) @operator.expression
[(attribute_operator) (combinator) (spread)] @operator

; Keyword roles use Neovim names; tree-sitter-highlight matches name parts, so `keyword.function` would render as `function`.
["@use" "@forward" "@import"] @keyword.import
"@return" @keyword.return
["@if" "@else" "@elseif"] @keyword.conditional
["@each" "@for" "@while"] @keyword.repeat
["@debug" "@warn"] @keyword.debug
"@error" @keyword.exception
["@function" "@mixin" "@include" "@content" "@extend" "@at-root"
 "as" "show" "hide" "with" "using" "returns" "in" "from" "to" "through" "if" "else" "of"] @keyword
["@media" "@supports" "@container" "@scope"
 "@keyframes" "@-webkit-keyframes" "@-moz-keyframes" "@-o-keyframes"
 "@namespace" "@charset" "@layer" "@property"
 "@font-face" "@font-feature-values" "@font-palette-values" "@counter-style"
 "@starting-style" "@view-transition" "@position-try" "@page"] @keyword.directive

[(string) (raw_text)] @string
(escape_sequence) @string.escape

["," "|"] @punctuation.delimiter

; Context overrides
; Emacs applies this section after base captures, preserving contextual roles.
; Class, ID and placeholder prefixes inherit the complete selector capture.
(pseudo_selector [":" "::"] @attribute)
; Dots outside class selectors still separate module members or literal words.
[(member_expression "." @punctuation.delimiter)
 (call_expression "." @punctuation.delimiter)
 (variable_declaration "." @punctuation.delimiter)
 (include_statement "." @punctuation.delimiter)
 (selector_arguments "." @punctuation.delimiter)
 (dotted_value "." @punctuation.delimiter)]
; Query and type operators retain their structural role.
[(query_statement (operator) @operator)
 (query_group (operator) @operator)
 (type_annotation (operator) @operator)]
(map_entry key: (plain_value) @property)
(keyframes_statement (declaration_block (rule_set (selectors [(tag_selector) @keyword (complex_selector (tag_selector) @keyword)]))))
; Comments right after `(`, after a sign or beside a feature name drop its role; tolerating them multiplies compile time.
(query_group "(" . (plain_value) @property . [")" (operator ["=" "<" "<=" ">" ">="])])
(query_group "(" . (operator ["+" "-"])* . [(number) (call_expression) (interpolation) (variable_name) (member_expression)]
 (operator ["=" "<" "<=" ">" ">="]) . (plain_value) @property)
; Shared words take the role of the statement that owns them.
[(for_statement ["from" "to" "through"] @keyword.repeat) (each_statement "in" @keyword.repeat)]
[(use_statement "as" @keyword.import) (forward_statement ["as" "show" "hide"] @keyword.import)
 (configuration "with" @keyword.import)]
[(else_clause "if" @keyword.conditional) (conditional_branch "else" @keyword.conditional)]
(parameter name: (_) @variable.parameter)
[(arguments (named_argument name: (variable_name) @variable.parameter))
 (conditional (named_argument name: (variable_name) @variable.parameter))]

(type_annotation ["<" ">"] @punctuation.bracket)
; A wildcard takes the role of the name it stands for.
[(use_statement "*" @module) (forward_statement "*" @module) (namespace_selector "*" @module)]
(type_annotation "*" @type)
(selector_arguments "*" @constant)
(keyframe_selector "%" @type)
(interpolation ["#{" "}"] @punctuation.special)
; A custom `--` name is a variable, even where its property, value, or query feature has a context role.
(dashed_name) @variable
