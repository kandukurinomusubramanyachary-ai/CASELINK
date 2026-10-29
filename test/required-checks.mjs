/**
 * Detect required checks that did not execute. Import previews legitimately report skipped CSV rows,
 * so only explicit test-skip markers and test summary counters are considered.
 */
export function countRequiredSkips(text) {
  const lineCount = pattern => (text.match(pattern) ?? []).length;
  const explicit =
    lineCount(/^\s*SKIP\b/gim) +
    lineCount(/^\s*ok\s+\d+\s+.*#\s*SKIP\b/gim) +
    lineCount(/^\s*PASS\b.*\bskipped\s*$/gim);

  let summary = 0;
  const summaryPatterns = [
    /^#\s+skipped\s+([1-9]\d*)\s*$/gim,
    /\bskipped:\s*([1-9]\d*)\b/gi,
    /^\s*([1-9]\d*)\s+skipped\s+\(not counted as passes\)/gim,
  ];
  for (const pattern of summaryPatterns) {
    for (const match of text.matchAll(pattern)) summary = Math.max(summary, Number(match[1]));
  }
  return Math.max(explicit, summary);
}
