// Append-only revert manifest: each banked change isolated for cherry-pick.

export function addEntry(list, e) {
  return [...list, {
    id: e.id, layer: e.layer, lens: e.lens, file: e.file,
    accept_reason: e.accept_reason, saved_pct: e.saved_pct, diffPath: e.diffPath,
  }];
}

export function renderManifest(list) {
  const head = `# optimize-codec-times — revert manifest\n\n| id | layer | lens | file | reason | saved% | diff |\n|----|-------|------|------|--------|--------|------|\n`;
  const rows = list.map(e =>
    `| ${e.id} | ${e.layer} | ${e.lens} | ${e.file} | ${e.accept_reason} | ${e.saved_pct} | ${e.diffPath} |`
  ).join('\n');
  return head + rows + '\n';
}
