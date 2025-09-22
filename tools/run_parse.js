const fs = require('fs');
const vm = require('vm');
const path = process.argv[2] || 'index.cjs';
const code = fs.readFileSync(path, 'utf8');
try {
  new vm.Script(code, { filename: path });
  console.log('Parse OK');
} catch (err) {
  console.error('Parse error:');
  console.error(err && err.stack || err);
  process.exit(1);
}
