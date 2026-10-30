// Word-level diff (LCS) for comparing two model outputs.

export function tokens(text) {
  return text.match(/\s+|[^\s]+/g) || [];
}

/** Returns { a: [{text, same}], b: [{text, same}], divergeA, divergeB } */
export function wordDiff(aText, bText, limit = 1500) {
  const a = tokens(aText).slice(0, limit);
  const b = tokens(bText).slice(0, limit);
  const n = a.length;
  const m = b.length;
  const dp = Array.from({ length: n + 1 }, () => new Uint16Array(m + 1));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  const ra = [];
  const rb = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      ra.push({ text: a[i++], same: true });
      rb.push({ text: b[j++], same: true });
    } else if (dp[i + 1][j] >= dp[i][j + 1]) ra.push({ text: a[i++], same: false });
    else rb.push({ text: b[j++], same: false });
  }
  while (i < n) ra.push({ text: a[i++], same: false });
  while (j < m) rb.push({ text: b[j++], same: false });
  const firstDiff = (arr) => arr.findIndex((t) => !t.same && t.text.trim());
  return { a: ra, b: rb, divergeA: firstDiff(ra), divergeB: firstDiff(rb) };
}

/** Index of the first differing word between two texts (or -1 if identical). */
export function firstDivergence(aText, bText) {
  const a = aText.split(/\s+/).filter(Boolean);
  const b = bText.split(/\s+/).filter(Boolean);
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) if (a[i] !== b[i]) return i;
  return a.length === b.length ? -1 : n;
}
