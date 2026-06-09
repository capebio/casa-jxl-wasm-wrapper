// fixtures.ts
// Approved fixture paths for testing the Pyramid Gallery Pipeline.
// Conforms strictly to the 2026-06-07-pyramid-gallery-design.md specification.

export interface FixtureMetadata {
  path: string;
  format: "orf" | "dng" | "cr2" | "jpg";
  description?: string;
}

/**
 * List of approved local test fixtures with exact paths preserved as strings.
 * File existence is not checked; spelling of paths is preserved exactly.
 */
export const APPROVED_FIXTURES: readonly FixtureMetadata[] = [
  {
    path: "tests/_MG_1750.CR2",
    format: "cr2",
    description: "CR2 test fixture 1",
  },
  {
    path: "tests/ADH 1248.CR2",
    format: "cr2",
    description: "CR2 test fixture 2",
  },
  {
    path: "P1110226 windows.jpg",
    format: "jpg",
    description: "Local JPG test fixture with spaces",
  },
  {
    path: "tests/PXL_20260527_180319603.RAW-02.ORIGINAL.dng",
    format: "dng",
    description: "DNG test fixture 1",
  },
  {
    path: "tests/PXL_20260527_145756882.RAW-02.ORIGINAL.dng",
    format: "dng",
    description: "DNG test fixture 2",
  },
  {
    path: "specimens/P2200566 Adenolobus pechuelii.ORF",
    format: "orf",
    description: "Adenolobus pechuelii specimen ORF",
  },
  {
    path: "specimens/P2200571.ORF",
    format: "orf",
    description: "ORF test fixture 2",
  },
  {
    path: "specimens/P2200476 Pogonospermum cleomoides.ORF",
    format: "orf",
    description: "Pogonospermum cleomoides specimen ORF",
  },
] as const;
