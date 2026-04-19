const fs = require('fs');
const data = JSON.parse(fs.readFileSync('eslint-out.json', 'utf8'));
const errors = {};
for (const f of data) {
  for (const m of f.messages) {
    if (m.severity === 2) {
      const key = m.ruleId || 'unknown';
      if (!errors[key]) errors[key] = [];
      const relPath = f.filePath.replace(/\\/g, '/').replace(/^.*slingshot\//, '');
      errors[key].push(relPath + ':' + m.line);
    }
  }
}
for (const [rule, locs] of Object.entries(errors).sort((a, b) => b[1].length - a[1].length)) {
  console.log(rule + ' (' + locs.length + '):');
  for (const l of locs) console.log('  ' + l);
}
