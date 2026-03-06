const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const from = path.join(root, 'renderer');
const to = path.join(root, 'dist', 'renderer');

fs.mkdirSync(to, { recursive: true });
for (const file of ['index.html', 'styles.css']) {
  fs.copyFileSync(path.join(from, file), path.join(to, file));
}

console.log('Copied renderer assets to dist/renderer');
