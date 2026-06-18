// Modular progressive encode. modular:1 lossless variant → equal() pixel-exact;
// modular lossy (distance>0) → quality() Butteraugli. Agent picks per candidate config.
export const modularNotes = 'classify lossless via distance===0 / modular-lossless flag (spec §5a)';
