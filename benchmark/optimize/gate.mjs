// §5a hard quality gate, then §5b acceptance (faster OR offsetting gain).

export function evaluate(v, opts) {
  const eps = opts.slowdownEpsilon ?? 3;
  const thr = opts.butteraugliThreshold ?? 1.0;

  // --- §5a quality gate (hard) ---
  if (v.lossless) {
    if (!v.pixel_exact) return reject('lossless path not pixel-exact');
  } else {
    if ((v.butteraugli_delta ?? Infinity) > thr) {
      return reject(`butteraugli Δ ${v.butteraugli_delta} > ${thr}`);
    }
  }

  // --- §5b acceptance ---
  const saved = v.saved_pct ?? 0;
  if (saved > 0) return accept('faster');
  // equal-or-slightly-slower band: saved >= -eps
  if (saved >= -eps) {
    if ((v.rss_delta_mb ?? 0) < 0) return accept('leaner');
    if (v.removes_dup) return accept('simpler');
    if (v.role === 'fallback') return accept('feature');
  }
  return reject(`pure regression (saved_pct ${saved}, no memory/dedup/feature gain)`);

  function accept(reason) { return { accepted: true, accept_reason: reason, reason: `accepted: ${reason}` }; }
  function reject(reason) { return { accepted: false, accept_reason: null, reason: `rejected: ${reason}` }; }
}
