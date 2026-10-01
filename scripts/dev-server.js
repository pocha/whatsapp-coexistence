#!/usr/bin/env node
// Local dev orchestrator: builds the frontend, serves public/ statically,
// watches views/ for changes, and starts the Firebase emulators — all from
// one `npm start`. No new dependency for the static server (plain
// http/fs), and the emulators are spawned async (not spawnSync) on
// purpose: spawnSync blocks this process's event loop for the emulators'
// entire lifetime, which would starve the static server too — the exact
// bug fixed in functions/test/run-integration.js.
const { spawn, execSync } = require('node:child_process');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const PUBLIC_DIR = path.join(ROOT, 'public');
const VIEWS_DIR = path.join(ROOT, 'views');
const STATIC_PORT = 8765;

const MIME = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.json': 'application/json',
};

function buildPages() {
  execSync('npm run build:pages', { cwd: ROOT, stdio: 'inherit' });
}

function serveStatic() {
  const server = http.createServer((req, res) => {
    let urlPath = decodeURIComponent(req.url.split('?')[0]);
    if (urlPath.endsWith('/')) urlPath += 'index.html';
    const filePath = path.join(PUBLIC_DIR, urlPath);
    if (!filePath.startsWith(PUBLIC_DIR)) {
      res.writeHead(403).end();
      return;
    }
    fs.readFile(filePath, (err, data) => {
      if (err) {
        res.writeHead(404).end('Not found');
        return;
      }
      // No caching for local dev — otherwise browsers (especially for
      // `<script type="module">` imports) can keep serving a stale file
      // after an edit, which looks exactly like "my fix isn't working."
      res.writeHead(200, {
        'Content-Type': MIME[path.extname(filePath)] || 'application/octet-stream',
        'Cache-Control': 'no-store',
      });
      res.end(data);
    });
  });
  server.listen(STATIC_PORT, '127.0.0.1', () => {
    console.log(`Static frontend: http://localhost:${STATIC_PORT}/dashboard/`);
  });
}

function watchViewsAndRebuild() {
  let pending = false;
  fs.watch(VIEWS_DIR, { recursive: true }, () => {
    if (pending) return;
    pending = true;
    setTimeout(() => {
      pending = false;
      try {
        buildPages();
      } catch {
        // Build errors already printed by the inherited stdio; keep watching.
      }
    }, 200); // debounce rapid saves
  });
}

console.log('Building pages…');
buildPages();
serveStatic();
watchViewsAndRebuild();

console.log('Starting Firebase emulators (functions, firestore, auth)…');
// `npm run serve` spawns `firebase emulators:start`, which itself spawns
// several more processes (a separate Java process for Firestore, a Node
// process for the Functions runtime, the emulator UI server, …). Signaling
// just this direct child isn't enough — it relies on every layer forwarding
// the signal down, which isn't guaranteed and has left orphaned emulator
// processes behind in practice. `detached: true` puts this child in its own
// process group, so SIGINT can be sent to the whole group at once (the
// negative-PID form below) instead of just the top-level `npm` process.
const emulators = spawn('npm', ['run', 'serve'], {
  cwd: path.join(ROOT, 'functions'),
  stdio: ['inherit', 'pipe', 'inherit'],
  detached: true,
});

// Firebase's own CLI output is still forwarded live to the terminal as
// usual — we just also watch it for the "ready" banner, so we can print
// where to actually go *after* everything (not just the static server) is
// up, instead of at script start when Functions/Firestore aren't ready yet.
let announced = false;
emulators.stdout.on('data', (chunk) => {
  process.stdout.write(chunk);
  if (!announced && chunk.toString().includes('All emulators ready')) {
    announced = true;
    console.log(`\nOpen the app: http://localhost:${STATIC_PORT}/dashboard/\n`);
  }
});

emulators.on('exit', (code) => process.exit(code ?? 0));
process.on('SIGINT', () => {
  try {
    process.kill(-emulators.pid, 'SIGINT'); // negative PID = whole process group
  } catch {
    emulators.kill('SIGINT'); // fallback if the group's already gone
  }
});
