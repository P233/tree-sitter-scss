module.exports = [
  {
    files: ["grammar.js", "eslint.config.js", "bindings/node/*.js", "scripts/*.js"],
    languageOptions: {
      sourceType: "commonjs",
      globals: Object.fromEntries(
        [
          "__dirname",
          "console",
          "process",
          "setTimeout",
          "clearTimeout",
          "fetch",
          "grammar",
          "seq",
          "choice",
          "repeat",
          "repeat1",
          "optional",
          "alias",
          "field",
          "token",
          "prec"
        ].map(name => [name, "readonly"])
      )
    },
    rules: {
      "no-undef": "error",
      "no-unused-vars": ["error", { argsIgnorePattern: "^_" }],
      "no-unreachable": "error",
      "no-dupe-keys": "error",
      "no-constant-condition": "error"
    }
  }
];
