import fs from 'fs';
import path from 'path';

function walk(dir) {
  let results = [];
  const list = fs.readdirSync(dir);
  list.forEach(file => {
    const fullPath = path.join(dir, file);
    const stat = fs.statSync(fullPath);
    if (stat && stat.isDirectory()) {
      results = results.concat(walk(fullPath));
    } else {
      results.push(fullPath);
    }
  });
  return results;
}

const dir = "C:\\Foo\\raw-converter-wasm\\docs\\outputs";
const files = walk(dir);

files.forEach(f => {
  if (f.endsWith('.toon') || f.endsWith('.txt') || f.endsWith('.md')) {
    const content = fs.readFileSync(f, 'utf-8');
    if (content.includes('Encoding Speed')) {
      console.log(`=== FILE: ${f} ===`);
      const lines = content.split('\n');
      lines.forEach(l => {
        if (l.includes('Encoding Speed')) {
          console.log(l.trim());
        }
      });
      console.log("");
    }
  }
});
