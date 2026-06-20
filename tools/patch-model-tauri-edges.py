"""patch-model-tauri-edges.py
1. Add tauri input edges (RAW files → t_pipeline)
2. Add t_casabio → casabio_encode edge
3. Move de_event to first among dec_rs children (reduces overlap)
"""
import json, sys
sys.stdout.reconfigure(encoding='utf-8')

with open('docs/ecosystem-map.model.json', encoding='utf-8') as f:
    d = json.load(f)

# ─── 1. New edges ─────────────────────────────────────────────────────────────
new_edges = [
    {"f":"orf_file",   "t":"t_pipeline", "l":"ORF bytes (native)",       "pay":"bytes"},
    {"f":"dng_file",   "t":"t_pipeline", "l":"DNG bytes (native)",       "pay":"bytes"},
    {"f":"cr2_file",   "t":"t_pipeline", "l":"CR2 bytes (native)",       "pay":"bytes"},
    {"f":"t_casabio",  "t":"casabio",    "l":"encode_variants (native)", "pay":"rgba8"},
]

# De-dup: skip any edge whose (f,t) already exists
existing = {(e['f'], e['t']) for e in d['edges']}
added = 0
for e in new_edges:
    key = (e['f'], e['t'])
    if key not in existing:
        d['edges'].append(e)
        existing.add(key)
        print(f"  + edge {e['f']} → {e['t']}")
        added += 1
print(f"  Added {added} edges ({len(d['edges'])} total)")

# ─── 2. Move de_event to be first among dec_rs children ──────────────────────
# Find indices of dec_rs children in the node array
dec_rs_child_ids = ['de_decoder','de_opts','de_event','de_image','de_jxtc','de_compat']
child_indices = {n['id']: i for i, n in enumerate(d['nodes']) if n['id'] in dec_rs_child_ids}
print("dec_rs children current indices:", child_indices)

# Extract child nodes in current order
children_in_order = sorted(child_indices.items(), key=lambda x: x[1])  # [(id, idx), ...]
child_nodes = [d['nodes'][idx] for _id, idx in children_in_order]

# Reorder: de_event first
de_event_node = next(n for n in child_nodes if n['id'] == 'de_event')
rest = [n for n in child_nodes if n['id'] != 'de_event']
reordered = [de_event_node] + rest

# Write back to the same positions
first_idx = children_in_order[0][1]
for i, node in enumerate(reordered):
    d['nodes'][first_idx + i] = node
    print(f"  nodes[{first_idx+i}] = {node['id']}")

# ─── 3. Write ────────────────────────────────────────────────────────────────
with open('docs/ecosystem-map.model.json', 'w', encoding='utf-8') as f:
    json.dump(d, f, ensure_ascii=False, indent=2)
print(f"\nDone. {len(d['nodes'])} nodes, {len(d['edges'])} edges")
