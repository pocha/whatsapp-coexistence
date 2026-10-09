// Orchestrates the integration test layer:
//   1. Start the Meta API stub (fixed port).
//   2. Temporarily append GRAPH_API_BASE to .env, pointing at the stub —
//      the functions emulator only reads Meta's base URL from this file
//      (env-var passthrough to its spawned runtime isn't reliable), and
//      .env is the same file plain local dev (`npm start`) uses, so this
//      must be added just for the test run and removed straight after —
//      otherwise normal dev would silently point at a stub that isn't
//      running instead of real Meta.
//   3. Run `firebase emulators:exec`, which starts real Firestore/Auth/
//      Functions emulators, runs our test files against them, and tears
//      down automatically.
//   4. Restore .env and stop the stub, in a `finally`, so a failed run
//      never leaves dev pointed at the stub either.
//
// Uses async spawn (not spawnSync) on purpose: spawnSync blocks this
// process's event loop for the entire child's lifetime, which would starve
// the stub server's own HTTP handling — it runs in this same process — so
// every request to it would hang until the child exits.
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { startMetaStub } = require('./meta-stub');

const META_STUB_PORT = 9905;
const ENV_PATH = path.join(__dirname, '..', '.env');

async function main() {
  const stub = await startMetaStub(META_STUB_PORT);
  // Drop any stub settings an interrupted earlier run left behind, so they are never restored
  // into the real .env that `npm start` uses.
  const originalEnv = fs
    .readFileSync(ENV_PATH, 'utf8')
    .replace(/^(GRAPH_API_BASE|ALLOW_HTTP_ENDPOINT)=.*\n?/gm, '');
  fs.writeFileSync(ENV_PATH, originalEnv);

  let exitCode = 1;
  try {
    fs.writeFileSync(ENV_PATH, `${originalEnv}\nGRAPH_API_BASE=http://127.0.0.1:${META_STUB_PORT}\nALLOW_HTTP_ENDPOINT=true\n`);

    exitCode = await new Promise((resolve) => {
      const child = spawn(
        'firebase',
        ['emulators:exec', '--only', 'firestore,auth,functions', 'node --test test/integration/*.test.js'],
        { cwd: path.join(__dirname, '..'), stdio: 'inherit' },
      );
      child.on('exit', (code) => resolve(code ?? 1));
    });
  } finally {
    fs.writeFileSync(ENV_PATH, originalEnv);
    await new Promise((resolve) => stub.close(resolve));
  }

  process.exit(exitCode);
}

main();
