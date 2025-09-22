const fs = require('fs');
const path = process.argv[2] || 'index.cjs';
const lineNum = parseInt(process.argv[3], 10) || 2494;
const s = fs.readFileSync(path, 'utf8');
const lines = s.split('\n');
const idx = lines.slice(0, lineNum-1).reduce((a,l)=>a+l.length+1,0);
const before = s.substring(Math.max(0, idx-80), idx + 1);
const after = s.substring(idx, Math.min(s.length, idx+80));
console.log('--- LINE',lineNum,'---');
console.log(lines[lineNum-1]);
console.log('--- RAW CONTEXT (visible hex/dec codes) ---');
const show = s.substring(Math.max(0, idx-40), Math.min(s.length, idx+40));
let out = '';
for (let i=0;i<show.length;i++){
  const ch = show[i];
  const code = show.charCodeAt(i);
  out += (code<32||code>126) ? `\n[${i}] U+${code.toString(16).padStart(4,'0')}(${code})` : `\n[${i}] '${ch}'(${code})`;
}
console.log(out);
console.log('--- show chunk ---');
console.log(show);
