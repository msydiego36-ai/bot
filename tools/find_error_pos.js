const fs = require('fs');
const vm = require('vm');
const path = process.argv[2] || 'index.cjs';
const code = fs.readFileSync(path, 'utf8');

function posToLineCol(s, i) {
  const lines = s.substring(0, i).split('\n');
  const line = lines.length;
  const col = lines[lines.length - 1].length + 1;
  return { line, col };
}

let lo = 0, hi = code.length;
let firstFail = -1;
while (lo <= hi) {
  const mid = Math.floor((lo + hi) / 2);
  const chunk = code.slice(0, mid);
  try {
    new vm.Script(chunk);
    // parsed OK up to mid
    lo = mid + 1;
  } catch (e) {
    firstFail = mid;
    hi = mid - 1;
  }
}

if (firstFail === -1) {
  console.log('No parse failures in prefixes; file may fully parse (or error at EOF).');
  process.exit(0);
}

const ctx = posToLineCol(code, firstFail);
console.log('First failing index (approx):', firstFail, 'line:', ctx.line, 'col:', ctx.col);
console.log('Context around failure:\n--- before ---\n' + code.substring(Math.max(0, firstFail-80), firstFail) + '\n--- after ---\n' + code.substring(firstFail, Math.min(code.length, firstFail+80)));
