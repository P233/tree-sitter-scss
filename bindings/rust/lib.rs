//! SCSS language support for Tree-sitter.
//!
//! ```
//! let mut parser = tree_sitter::Parser::new();
//! parser.set_language(&tree_sitter_scss::LANGUAGE.into()).unwrap();
//! let tree = parser.parse("body { color: red; }", None).unwrap();
//! assert!(!tree.root_node().has_error());
//! ```

use tree_sitter_language::LanguageFn;

unsafe extern "C" {
    fn tree_sitter_scss() -> *const ();
    fn tree_sitter_stylesheet_css() -> *const ();
}

/// The SCSS language, convertible into a Tree-sitter `Language`.
pub const LANGUAGE: LanguageFn = unsafe { LanguageFn::from_raw(tree_sitter_scss) };
/// The CSS dialect, sharing the SCSS parsing tables with literal CSS strings.
pub const CSS_LANGUAGE: LanguageFn = unsafe { LanguageFn::from_raw(tree_sitter_stylesheet_css) };
pub const NODE_TYPES: &str = include_str!("../../src/node-types.json");
pub const HIGHLIGHTS_QUERY: &str = include_str!("../../queries/highlights.scm");

#[cfg(test)]
mod tests {
    #[test]
    fn css_and_scss_keep_independent_literal_semantics() {
        let source = ".a { content: \"#{$color}\"; --value: #{$color}; }";
        let mut css = tree_sitter::Parser::new();
        let mut scss = tree_sitter::Parser::new();
        css.set_language(&super::CSS_LANGUAGE.into()).unwrap();
        scss.set_language(&super::LANGUAGE.into()).unwrap();
        let css_tree = css.parse(source, None).unwrap();
        let scss_tree = scss.parse(source, None).unwrap();
        assert!(!css_tree.root_node().has_error());
        assert!(!scss_tree.root_node().has_error());
        assert!(!css_tree.root_node().to_sexp().contains("interpolation"));
        assert!(scss_tree.root_node().to_sexp().contains("interpolation"));
        tree_sitter::Query::new(&super::CSS_LANGUAGE.into(), super::HIGHLIGHTS_QUERY).unwrap();
    }

    #[test]
    fn parses_scss_and_loads_highlights() {
        let language = super::LANGUAGE.into();
        let mut parser = tree_sitter::Parser::new();
        parser.set_language(&language).unwrap();
        let source = "$base-color: #abc; .card { color: $base-color; }";
        let tree = parser.parse(source, None).unwrap();
        assert!(
            !tree.root_node().has_error(),
            "{}",
            tree.root_node().to_sexp()
        );
        tree_sitter::Query::new(&language, super::HIGHLIGHTS_QUERY).unwrap();
    }
}
