// Builds infrastructure/build/ for SAM: server code + Cedar policy + production dependencies.
const fs = require('fs'), path = require('path'), { execSync } = require('child_process');
const root = path.join(__dirname, '..'), out = path.join(root, 'infrastructure', 'build');
fs.rmSync(out, { recursive: true, force: true });
fs.cpSync(path.join(root, 'server'), path.join(out, 'server'), { recursive: true });
fs.cpSync(path.join(root, 'aws', 'cedar'), path.join(out, 'aws', 'cedar'), { recursive: true });
fs.cpSync(path.join(root, 'public'), path.join(out, 'public'), { recursive: true });
fs.copyFileSync(path.join(root, 'package.json'), path.join(out, 'package.json'));
execSync('npm install --omit=dev --no-audit --no-fund', { cwd: out, stdio: 'inherit' });
console.log('Lambda bundle ready:', out);
