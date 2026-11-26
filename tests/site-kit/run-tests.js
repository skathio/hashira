// Lets `node --test tests/site-kit/` run from the repo root. Node 21 and later take a folder
// argument as one file to run and load it through package.json's `main`, which is this file: it
// runs every *.test.js here in a runner of its own and passes the result on. Node 20 searches the
// folder for test files itself and never loads this file.
'use strict';

const { spawnSync } = require('node:child_process');

// The outer runner marks its child with NODE_TEST_CONTEXT; left set, the inner runner would
// write its results in the outer runner's wire format instead of running as a suite of its own.
const { NODE_TEST_CONTEXT: _, ...env } = process.env;
const run = spawnSync(process.execPath, ['--test'], { cwd: __dirname, env, stdio: 'inherit' });
process.exit(run.status ?? 1);
