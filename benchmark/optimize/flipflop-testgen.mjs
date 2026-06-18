// Build a flipflop test-file source string (spec §3 capabilities assumed:
// async variants, quality() hook, bring-your-own inputs, variant role tag).

export function genTest({ name, description, lossless, baseline, candidate }) {
  const candRole = candidate.role ?? 'primary';
  const qualityBlock = lossless
    ? `export function equal(a, b) { return pixelExact(a, b); }`
    : `export function quality(out, baselineOut) { return butteraugli(out, baselineOut); }`;
  return `// AUTO-GENERATED flipflop test — optimize-codec-times
export const name = '${name}';
export const description = ${JSON.stringify(description)};

export const variants = [
  { name: '${baseline.label}', baseline: true, role: 'primary',
    run: async (input, ctx) => ${baseline.expr} },
  { name: '${candidate.label}', role: '${candRole}',
    run: async (input, ctx) => ${candidate.expr} },
];

${qualityBlock}
`;
}
