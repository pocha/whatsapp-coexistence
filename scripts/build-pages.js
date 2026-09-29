#!/usr/bin/env node
'use strict';

/**
 * Expands the page templates in views/pages/*.html into public/. Templates may:
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

const ROOT_DIR = path.join(__dirname, '..');
const PAGES_DIR = path.join(ROOT_DIR, 'views', 'pages');
const PARTIALS_DIR = path.join(ROOT_DIR, 'views', 'partials');
const PUBLIC_DIR = path.join(ROOT_DIR, 'public');

const PAGE_MAP = {
  'index.html': 'index.html',
  'privacy.html': 'privacy.html',
  'tos.html': 'tos.html',
  'data-deletion.html': 'data-deletion.html',
  'how-to/business-portfolio.html': 'how-to/business-portfolio.html',
  'how-to/meta-app.html': 'how-to/meta-app.html',
  'how-to/whatsapp-api-access.html': 'how-to/whatsapp-api-access.html',
};

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
  const withIncludes = resolveIncludes(rest, new Set());
  const finalHtml = substitutePlaceholders(withIncludes, vars);

  const outRelPath = PAGE_MAP[pageFile];
  const outPath = path.join(PUBLIC_DIR, outRelPath);
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, finalHtml, 'utf8');
  return outRelPath;
}

function main() {
  const written = [];
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
