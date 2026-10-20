/* global performance */
// Runs work untimed for about ms milliseconds, deleting each tree at once.
export function warmUp(work, ms) {
  const end = performance.now() + ms;
  do {
    const tree = work();
    if (!tree) throw new Error("Parser did not return a tree.");
    tree.delete();
  } while (performance.now() < end);
}

// Median of five batch means over warm runs of work, each batch lasting at least 10 ms; trees are deleted untimed.
export function measureWarm(work) {
  const run = () => {
    const tree = work();
    if (!tree) throw new Error("Parser did not return a tree.");
    return tree;
  };
  run().delete();

  const batchMeans = [];
  const trees = [];
  let runs = 0;
  try {
    while (batchMeans.length < 5) {
      while (trees.length) trees.pop().delete();
      const start = performance.now();
      let duration;
      do {
        trees.push(run());
        duration = performance.now() - start;
      } while (duration < 10);
      batchMeans.push(duration / trees.length);
      runs += trees.length;
    }
    batchMeans.sort((a, b) => a - b);
    return { medianMs: batchMeans[2], runs };
  } finally {
    while (trees.length) trees.pop().delete();
  }
}

export function formatDuration(ms) {
  const seconds = Number(ms.toPrecision(2)) >= 1000;
  const value = seconds ? ms / 1000 : ms;
  const rounded = Number(value.toPrecision(2));
  const decimals = Math.max(0, 1 - Math.floor(Math.log10(rounded)));
  return `${rounded.toFixed(decimals)} ${seconds ? "s" : "ms"}`;
}

export function formatTimings({ parse, highlighted }) {
  return `parse ${formatDuration(parse.medianMs)} · highlighted ${formatDuration(highlighted.medianMs)}`;
}

export function describeTimings({ parse, highlighted }) {
  const detail = ({ runs }) => `median of five batch means over ${runs.toLocaleString("en-US")} timed runs`;
  return `Parse: ${detail(parse)}. Highlighted: ${detail(highlighted)}.`;
}
