// Lets `node --test docs-site/` run from the repo root. Node 21 and later take a folder argument
// as one file to run and load it through package.json's `main`, which is this file: it runs the
// suite the way `npm test` does, one process per *.test.mjs file, and passes the result on.
import { spawnSync } from 'node:child_process'

// The outer runner marks its child with NODE_TEST_CONTEXT; left set, the inner runner would
// write its results in the outer runner's wire format instead of running as a suite of its own.
const { NODE_TEST_CONTEXT: _, ...env } = process.env
const run = spawnSync(process.execPath, ['--test'], { cwd: import.meta.dirname, env, stdio: 'inherit' })
process.exit(run.status ?? 1)
