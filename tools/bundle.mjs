/**
 * Inlines the ES modules into sim/index.html to produce a single distributable
 * file (dist/visionband-sim.html) that runs from anywhere — no local server,
 * no module resolution, publishable as an Artifact.
 *
 *   node tools/bundle.mjs
 *
 * The modules are hand-authored to make this safe: every import and export is a
 * single line, so stripping them with a regex is sufficient and no real bundler
 * is warranted yet.
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

// Dependency order. encoder first — audio.js and main.js both consume it;
// bvh before world before scene/room, which both build Worlds.
const MODULES = [
  'sonification/encoder.js',
  'sim/palette.js',
  'sim/bvh.js',
  'sim/world.js',
  'sim/scene.js',
  'sim/room.js',
  'sim/sensor.js',
  'sim/reconstruct.js',
  'sim/audio.js',
  'sim/main.js',
];

// The scanned room ships inside the page: an Artifact is a single file, and the
// CSP blocks fetching a sibling .bin anyway.
const ROOM = 'sim/rooms/livingroom';

const strip = (src) =>
  src
    .split('\n')
    .filter((l) => !/^\s*import\s.+from\s+['"].+['"];?\s*$/.test(l))
    .map((l) => l.replace(/^(\s*)export\s+(const|let|function|class|async)\b/, '$1$2'))
    .filter((l) => !/^\s*export\s*\{/.test(l))
    .join('\n');

const banner = (path) => `\n// ${'='.repeat(66)}\n// ${path}\n// ${'='.repeat(66)}\n`;

const sources = new Map(MODULES.map((m) => [m, readFileSync(join(root, m), 'utf8')]));

// Every module a bundled module imports must itself be bundled. Forgetting one
// produces a page that loads and then dies on a bare ReferenceError, which is
// invisible until something is clicked — so it is checked here instead.
const listed = new Set(MODULES.map((m) => m.split('/').pop()));
const missing = [];
for (const [name, src] of sources) {
  for (const m of src.matchAll(/^\s*import\s.*?from\s+['"](\.[^'"]+)['"]/gm)) {
    const dep = m[1].split('/').pop();
    if (!listed.has(dep)) missing.push(`${name} imports ${m[1]}`);
  }
}
if (missing.length) {
  console.error('Modules imported but not in MODULES:\n  ' + missing.join('\n  '));
  process.exit(1);
}

const code = MODULES.map((m) => banner(m) + strip(sources.get(m))).join('\n');

// room.js reads window.__VISIONBAND_ROOM__ when present and falls back to fetch
// otherwise, so the same source serves the dev server and the bundle.
let roomPreamble = '';
try {
  const meta = JSON.parse(readFileSync(join(root, `${ROOM}.json`), 'utf8'));
  const b64 = readFileSync(join(root, `${ROOM}.bin`)).toString('base64');
  roomPreamble =
    `window.__VISIONBAND_ROOM__ = {\n` +
    `  meta: ${JSON.stringify(meta)},\n` +
    `  base64: "${b64}"\n};\n`;
  console.log(`inlined room: ${meta.triangleCount} tris, ${(b64.length / 1024 / 1024).toFixed(2)} MB base64`);
} catch {
  console.warn(`no room at ${ROOM}.bin — bundle will ship without the scanned scene`);
}

const html = readFileSync(join(root, 'sim/index.html'), 'utf8').replace(
  '<script type="module" src="./main.js"></script>',
  `<script>\n${roomPreamble}</script>\n<script type="module">\n${code}\n</script>`
);

// Sanity: a leftover bare import means a module used a form the stripper missed,
// and the page would fail silently in the browser.
const leftover = code.match(/^\s*(import|export)\s/m);
if (leftover) {
  console.error(`Unstripped module syntax: ${leftover[0].trim()}`);
  process.exit(1);
}

mkdirSync(join(root, 'dist'), { recursive: true });

const out = join(root, 'dist/visionband-sim.html');
writeFileSync(out, html);
console.log(`${out}  ${(html.length / 1024).toFixed(1)} kB`);

// Artifact variant: the host supplies its own doctype/head/body skeleton, so
// the outer shell has to come off or the page ends up with two of everything.
const artifact = html
  .replace(/^[\s\S]*?<meta name="viewport"[^>]*>\s*/, '')
  .replace(/<\/head>\s*<body>\s*/, '')
  .replace(/\s*<\/body>\s*<\/html>\s*$/, '\n');

// Match on a tag boundary, not a prefix — <header> starts with "<head".
const shell = artifact.match(/<!doctype|<\/?(html|head|body)(\s|>)/i);
if (shell) {
  console.error(`Artifact variant still contains shell markup: ${shell[0]}`);
  process.exit(1);
}

const artOut = join(root, 'dist/visionband-sim.artifact.html');
writeFileSync(artOut, artifact);
console.log(`${artOut}  ${(artifact.length / 1024).toFixed(1)} kB`);
