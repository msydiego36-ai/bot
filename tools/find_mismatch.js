const fs = require('fs');
const path = process.argv[2] || 'index.cjs';
const code = fs.readFileSync(path, 'utf8');

function posToLineCol(s, i) {
  const lines = s.substring(0, i).split('\n');
  const line = lines.length;
  const col = lines[lines.length - 1].length + 1;
  return { line, col };
}

const start = code.indexOf("client.on('interactionCreate'");
const from = start !== -1 ? start : 0;

let stack = [];
let inSingle = false, inDouble = false, inBack = false, inBlock = false, inLine = false, esc = false;

for (let i = from; i < code.length; i++) {
  const ch = code[i];
  const next2 = code.substring(i, i+2);

  if (inLine) {
    if (ch === '\n') inLine = false;
    continue;
  }
  if (inBlock) {
    if (next2 === '*/') { inBlock = false; i++; continue; }
    continue;
  }
  if (inSingle) {
    if (!esc && ch === "'") inSingle = false; 
    esc = !esc && ch === '\\';
    continue;
  }
  if (inDouble) {
    if (!esc && ch === '"') inDouble = false;
    esc = !esc && ch === '\\';
    continue;
  }
  if (inBack) {
    if (!esc && ch === '`') inBack = false;
    esc = !esc && ch === '\\';
    continue;
  }

  if (next2 === '//') { inLine = true; i++; continue; }
  if (next2 === '/*') { inBlock = true; i++; continue; }
  if (ch === "'") { inSingle = true; esc = false; continue; }
  if (ch === '"') { inDouble = true; esc = false; continue; }
  if (ch === '`') { inBack = true; esc = false; continue; }

  if (ch === '(' || ch === '{' || ch === '[') {
    stack.push({ ch, i });
  } else if (ch === ')' || ch === '}' || ch === ']') {
    const last = stack[stack.length - 1];
    if (!last) {
      const p = posToLineCol(code, i);
      console.log('Unmatched closing', ch, 'at', p, 'context:\n' + code.substring(Math.max(0,i-40), i+40));
      process.exit(1);
    }
    const matches = (last.ch === '(' && ch === ')') || (last.ch === '{' && ch === '}') || (last.ch === '[' && ch === ']');
    if (matches) stack.pop();
    else {
      const p = posToLineCol(code, i);
      console.log('Mismatched closing', ch, 'for', last.ch, 'opened at', posToLineCol(code,last.i), 'closed at', p);
      console.log('context:\n' + code.substring(Math.max(0,i-40), i+40));
      process.exit(1);
    }
  }
}

if (stack.length) {
  const top = stack[stack.length - 1];
  console.log('Unclosed opener', top.ch, 'opened at', posToLineCol(code, top.i));
  console.log('context:\n' + code.substring(Math.max(0, top.i-40), top.i+120));
  process.exit(1);
}

console.log('All matched from', from, 'to end');
