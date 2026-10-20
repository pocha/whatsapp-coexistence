#!/usr/bin/env node
// Builds the body of the public Capabilities page from README.md, so what the site says we support is what the
// README documents and the two cannot drift apart. Run by `npm run build:pages`, before build-pages.js, which
// puts the result (views/partials/capabilities-body.html, generated and not committed) into views/pages/capabilities.html.
//
// It takes two sections of the README, "## API" and "## MCP server", and shapes them for the site:
//   <!-- docs:omit -->   ...   <!-- /docs:omit -->     left out of the page (how it is deployed, internal calls)
//   <!-- docs:only        ...   -->                      written for the page only, hidden in the README
// Links to files in the repository are turned into links to GitHub, and the markdown becomes HTML in the
// site's own classes.
const fs = require('node:fs');
const path = require('node:path');
const { marked } = require('marked');

const ROOT = path.join(__dirname, '..');
const README = path.join(ROOT, 'README.md');
const OUT = path.join(ROOT, 'views', 'partials', 'capabilities-body.html');
const SECTIONS = ['API', 'MCP server'];
const REPO = 'https://github.com/pocha/whatsapp-coexistence/blob/main/';

/** The lines of one `## <title>` section, up to the next `## `. */
function section(lines, title) {
  const start = lines.findIndex((l) => l === `## ${title}`);
  if (start < 0) throw new Error(`README.md has no "## ${title}" section.`);
  let end = lines.findIndex((l, i) => i > start && /^## /.test(l));
  if (end < 0) end = lines.length;
  return lines.slice(start, end);
}

/** Applies the docs:omit and docs:only markers. */
function applyMarkers(lines) {
  const out = [];
  let omitting = false;
  let only = false;
  for (const line of lines) {
    if (line.trim() === '<!-- docs:omit -->') omitting = true;
    else if (line.trim() === '<!-- /docs:omit -->') omitting = false;
    else if (!omitting && /^<!-- docs:only\s*$/.test(line.trim())) only = true;
    else if (only && line.trim() === '-->') only = false;
    else if (!omitting && !/^<!--.*-->$/.test(line.trim())) out.push(line);
  }
  if (omitting || only) throw new Error('README.md has an unclosed docs:omit or docs:only marker.');
  return out;
}

const classes = [
  [/<h2>/g, '<h2 class="font-headline-lg text-headline-lg text-on-surface mt-12">'],
  [/<h3>/g, '<h3 class="section-title text-on-surface mt-8 mb-2">'],
  [/<p>/g, '<p class="text-on-surface-variant font-body-md my-3">'],
  [/<ul>/g, '<ul class="flex flex-col gap-2 list-disc list-inside text-on-surface-variant font-body-md my-3">'],
  [/<table>/g, '<div class="overflow-x-auto my-4"><table class="w-full text-sm text-left">'],
  [/<\/table>/g, '</table></div>'],
  [/<th>/g, '<th class="label-strong text-on-surface-variant pb-2 pr-4 align-bottom">'],
  [/<tr>/g, '<tr class="border-t border-outline-variant">'],
  [/<td>/g, '<td class="py-2 pr-4 align-top text-on-surface-variant">'],
  [/<a href=/g, '<a class="text-primary font-bold hover:underline" href='],
  [/<pre>/g, '<pre class="bg-surface-container rounded-lg p-3 font-mono text-xs overflow-x-auto my-3">'],
  [/<code>/g, '<code class="font-mono text-[0.85em] bg-surface-container rounded px-1">'],
];

function build() {
  const lines = fs.readFileSync(README, 'utf8').split('\n');
  const markdown = SECTIONS.flatMap((title) => applyMarkers(section(lines, title))).join('\n');
  const renderer = new marked.Renderer();
  // A link to a file in the repository, written relative to the README, becomes a link to it on GitHub.
  renderer.link = ({ href, title, text }) => {
    const target = /^(https?:|#|mailto:)/.test(href) ? href : REPO + href.replace(/^\.\//, '');
    return `<a href="${target}"${title ? ` title="${title}"` : ''}${/^http/.test(target) ? ' target="_blank" rel="noopener"' : ''}>${text}</a>`;
  };
  let html = marked.parse(markdown, { gfm: true, renderer });
  // `<code>` inside a `<pre>` keeps its own look.
  for (const [pattern, replacement] of classes) html = html.replace(pattern, replacement);
  html = html.replace(/(<pre[^>]*>)<code class="[^"]*">/g, '$1<code>');
  // The README's section names are written for developers.
  html = html.replace('>API</h2>', '>What you can do: the API</h2>').replace('>MCP server</h2>', '>For AI tools: the MCP server</h2>');
  return html;
}

const html = build();
// Only write when it changed: the dev server rebuilds whenever something under views/ changes.
if (!fs.existsSync(OUT) || fs.readFileSync(OUT, 'utf8') !== html) fs.writeFileSync(OUT, html);
console.log('built the capabilities body from README.md');
