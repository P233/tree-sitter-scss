/* global performance */
export function parseWarm(parser, source) {
  const warmup = parser.parse(source);
  if (!warmup) throw new Error("Parser did not return a tree.");
  warmup.delete();

  const batchMeans = [];
  const trees = [];
  let elapsed = 0;
  let parses = 0;
  try {
    do {
      while (trees.length) trees.pop().delete();
      const start = performance.now();
      let duration;
      do {
        const tree = parser.parse(source);
        if (!tree) throw new Error("Parser did not return a tree.");
        trees.push(tree);
        duration = performance.now() - start;
      } while (duration < 10);
      batchMeans.push(duration / trees.length);
      parses += trees.length;
      elapsed += duration;
    } while (batchMeans.length < 5 || elapsed < 100);

    batchMeans.sort((a, b) => a - b);
    const middle = Math.floor(batchMeans.length / 2);
    const medianMs = batchMeans.length % 2 ? batchMeans[middle] : (batchMeans[middle - 1] + batchMeans[middle]) / 2;
    return { tree: trees.pop(), parseTime: { medianMs, batches: batchMeans.length, parses } };
  } finally {
    while (trees.length) trees.pop().delete();
  }
}

export function formatParseTime({ medianMs, batches, parses }) {
  const seconds = Number(medianMs.toPrecision(2)) >= 1000;
  const value = seconds ? medianMs / 1000 : medianMs;
  const rounded = Number(value.toPrecision(2));
  const decimals = Math.max(0, 1 - Math.floor(Math.log10(rounded)));
  return `${rounded.toFixed(decimals)} ${seconds ? "s" : "ms"} (${batches} batches · ${parses} parses)`;
}
