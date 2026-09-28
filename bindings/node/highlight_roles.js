// Test helper: resolves captures the way current highlighters render them. Nested ranges keep the
// innermost capture; captures of one range resolve to the later pattern, even across parent and child nodes.
function effectiveCaptures(query, root) {
  const byRange = new Map();
  for (const match of query.matches(root)) {
    for (const { name, node } of match.captures) {
      const key = `${node.startIndex}:${node.endIndex}`;
      const current = byRange.get(key);
      if (!current || match.pattern >= current.pattern) byRange.set(key, { name, node, pattern: match.pattern });
    }
  }
  return [...byRange.values()].map(({ name, node }) => ({ name, node }));
}

module.exports = { effectiveCaptures };
