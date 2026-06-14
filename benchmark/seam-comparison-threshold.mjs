export const SEAM_MISMATCH_RATIO_TOLERANCE = 0.001;
export const SEAM_MAX_DIFF_TOLERANCE = 16;

export function assessSeamComparison({ mismatches, totalBytes, maxDiff }) {
  if (!Number.isFinite(mismatches) || !Number.isFinite(totalBytes) || !Number.isFinite(maxDiff)) {
    return {
      status: "fail",
      shouldFail: true,
      message: "Invalid seam comparison inputs",
    };
  }

  if (totalBytes <= 0) {
    return {
      status: "fail",
      shouldFail: true,
      message: "Invalid seam comparison total byte count",
    };
  }

  const ratio = mismatches / totalBytes;
  const withinTolerance = ratio <= SEAM_MISMATCH_RATIO_TOLERANCE && maxDiff <= SEAM_MAX_DIFF_TOLERANCE;

  if (mismatches === 0) {
    return {
      status: "pass",
      shouldFail: false,
      message: "Seam comparison passed with exact byte identity",
      ratio,
    };
  }

  if (withinTolerance) {
    return {
      status: "warn",
      shouldFail: false,
      message: `Seam comparison within tolerance (${mismatches}/${totalBytes} mismatches, max diff ${maxDiff})`,
      ratio,
    };
  }

  return {
    status: "fail",
    shouldFail: true,
    message: `Seam comparison exceeded tolerance (${mismatches}/${totalBytes} mismatches, max diff ${maxDiff})`,
    ratio,
  };
}
