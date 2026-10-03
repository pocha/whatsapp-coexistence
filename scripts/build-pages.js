#!/usr/bin/env node
'use strict';

/**
 * Builds the static site into public/:
 *
 *   1. Compiles the browser TypeScript in src/ to the matching .js files in public/
 *      (esbuild, one output per source file, no bundling: the pages still import
 *      Firebase from Google's CDN and each other by absolute URL). Type-checking is
 *      `npm run typecheck`; esbuild only strips the types.
 *   2. Expands the page templates in views/pages/*.html into public/.
 *
 * Templates may:
 *
 *   - Declare per-page variables with:  <!--#var key="value"-->  (one per line)
 *   - Include a shared fragment from views/partials/<name>.html with:
 *       <!--#include partial="name"-->
 *   - Reference variables anywhere (including inside an included partial)
 *     with {{key}} tokens.
 *
 * Output mapping (views/pages/<name>.html -> public/<path>) is data-driven
 * via PAGE_MAP below, same approach as github.com/pocha/mudbot.
 */

const fs = require('node:fs');
const path = require('node:path');
const esbuild = require('esbuild');

const ROOT_DIR = path.join(__dirname, '..');
const PAGES_DIR = path.join(ROOT_DIR, 'views', 'pages');
const PARTIALS_DIR = path.join(ROOT_DIR, 'views', 'partials');
const PUBLIC_DIR = path.join(ROOT_DIR, 'public');
const SRC_DIR = path.join(ROOT_DIR, 'src');

const PAGE_MAP = {
  'index.html': 'index.html',
  'privacy.html': 'privacy.html',
  'tos.html': 'tos.html',
  'data-deletion.html': 'data-deletion.html',
  'dashboard.html': 'dashboard/index.html',
  'dashboard-waba-create.html': 'dashboard/waba/create.html',
  'dashboard-waba.html': 'dashboard/waba/index.html',
  'how-to/create-meta-business-portfolio-add-whatsapp-number.html': 'how-to/create-meta-business-portfolio-add-whatsapp-number.html',
  'how-to/get-whatsapp-api-for-free.html': 'how-to/get-whatsapp-api-for-free.html',
  'how-to/get-whatsapp-api-access-in-5-minutes.html': 'how-to/get-whatsapp-api-access-in-5-minutes.html',
  'how-to/migrate-existing-whatsapp-api-to-watobot.html': 'how-to/migrate-existing-whatsapp-api-to-watobot.html',
};

// Absolute site URL, used for canonical and Open Graph tags.
const SITE_URL = 'https://watobot.com';

const VAR_RE = /^<!--#var\s+([a-zA-Z0-9_]+)="([^"]*)"-->\n?/;
const INCLUDE_RE = /<!--#include\s+partial="([a-zA-Z0-9_-]+)"-->/g;

function readPartial(name) {
  const file = path.join(PARTIALS_DIR, `${name}.html`);
  if (!fs.existsSync(file)) {
    throw new Error(`Partial not found: ${name} (looked in ${file})`);
  }
  return fs.readFileSync(file, 'utf8').replace(/\r?\n$/, '');
}

function resolveIncludes(content, seen) {
  let result = content;
  let guard = 0;
  while (INCLUDE_RE.test(result)) {
    INCLUDE_RE.lastIndex = 0;
    result = result.replace(INCLUDE_RE, (match, name) => {
      if (seen.has(name)) {
        throw new Error(`Circular include detected for partial "${name}"`);
      }
      const nextSeen = new Set(seen);
      nextSeen.add(name);
      return resolveIncludes(readPartial(name), nextSeen);
    });
    guard += 1;
    if (guard > 50) {
      throw new Error('Include resolution did not terminate (possible cycle)');
    }
  }
  return result;
}

function extractVars(content) {
  const vars = {};
  let rest = content;
  let match;
  // eslint-disable-next-line no-cond-assign
  while ((match = rest.match(VAR_RE))) {
    vars[match[1]] = match[2];
    rest = rest.slice(match[0].length);
  }
  return { vars, rest };
}

function substitutePlaceholders(content, vars) {
  return content.replace(/\{\{([a-zA-Z0-9_]+)\}\}/g, (match, key) =>
    key in vars ? vars[key] : match,
  );
}

function buildPage(pageFile) {
  const srcPath = path.join(PAGES_DIR, pageFile);
  const raw = fs.readFileSync(srcPath, 'utf8');
  const { vars, rest } = extractVars(raw);
  const outRelPath = PAGE_MAP[pageFile];
  // Built-in vars available to every template (e.g. the head partial's
  // canonical and og:url): the page's public URL path, and the site origin.
  vars.site = SITE_URL;
  vars.path = outRelPath === 'index.html' ? '/' : `/${outRelPath}`;
  const withIncludes = resolveIncludes(rest, new Set());
  const finalHtml = substitutePlaceholders(withIncludes, vars);

  const outPath = path.join(PUBLIC_DIR, outRelPath);
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, finalHtml, 'utf8');
  return outRelPath;
}

function sourceFiles(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(full);
    return entry.name.endsWith('.ts') && !entry.name.endsWith('.d.ts') ? [full] : [];
  });
}

function buildScripts() {
  const entryPoints = sourceFiles(SRC_DIR);
  esbuild.buildSync({
    entryPoints,
    outdir: PUBLIC_DIR,
    outbase: SRC_DIR,
    format: 'esm',
    target: 'es2022',
    logLevel: 'warning',
  });
  return entryPoints.map((file) => path.relative(SRC_DIR, file).replace(/\.ts$/, '.js'));
}

function main() {
  const written = buildScripts();
  for (const pageFile of Object.keys(PAGE_MAP)) {
    const srcPath = path.join(PAGES_DIR, pageFile);
    if (!fs.existsSync(srcPath)) {
      throw new Error(`Missing page template: ${srcPath}`);
    }
    written.push(buildPage(pageFile));
  }
  for (const rel of written) {
    console.log(`built public/${rel}`);
  }
}

main();
