'use strict';

// Builds dist/: the page itself and marker.txt, the hashira ref this repo's
// caller pins.
const fs = require('node:fs');
const path = require('node:path');
const { hashiraRef } = require('./marker');

const root = path.join(__dirname, '..');
const dist = path.join(root, 'dist');
const caller = fs.readFileSync(path.join(root, '.github', 'workflows', 'ci.yml'), 'utf8');

fs.rmSync(dist, { recursive: true, force: true });
fs.mkdirSync(dist, { recursive: true });
fs.copyFileSync(path.join(root, 'src', 'index.html'), path.join(dist, 'index.html'));
fs.writeFileSync(path.join(dist, 'marker.txt'), `${hashiraRef(caller)}\n`);
