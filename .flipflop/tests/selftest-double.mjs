// Sanity fixture: 'double' does twice the work of 'base' → saved_pct ≈ -100%.
function work(n) { let s = 0; for (let i = 0; i < n; i++) s += Math.sqrt(i); return s; }
export const name = 'selftest-double';
export const description = 'baseline vs deliberate 2x-work — expect saved_pct ~= -100%';
export const variants = [
  { name: 'base', baseline: true, run: () => work(120000) },
  { name: 'double', run: () => work(240000) },
];
