// ════════════════════════════════════════════════════════════════════════
// SmartChef — Display-only line diff (LCS-based) for the Conflicts list UI
// (wayfinder ticket 06). Purely for showing a human what's different
// between two array-valued conflict versions (recipe steps/ingredients/
// tools) so they can judge "keep mine" vs "keep theirs" — NOT the merge
// algorithm. ADR 0002 already settled that those fields merge as one
// whole-array unit with no per-row identity; this has no bearing on that.
// ════════════════════════════════════════════════════════════════════════

export type DiffOp = { type: 'same' | 'removed' | 'added'; text: string };

export function diffLines(a: string[], b: string[]): DiffOp[] {
  const n = a.length;
  const m = b.length;
  const lcs: number[][] = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      lcs[i][j] = a[i] === b[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
    }
  }
  const ops: DiffOp[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      ops.push({ type: 'same', text: a[i] });
      i++;
      j++;
    } else if (lcs[i + 1][j] >= lcs[i][j + 1]) {
      ops.push({ type: 'removed', text: a[i] });
      i++;
    } else {
      ops.push({ type: 'added', text: b[j] });
      j++;
    }
  }
  while (i < n) ops.push({ type: 'removed', text: a[i++] });
  while (j < m) ops.push({ type: 'added', text: b[j++] });
  return ops;
}
