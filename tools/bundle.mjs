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

// Dependency order. encoder first — audio.js and main.js both consume it.
const MODULES = [
  'sonification/encoder.js',
  'sim/scene.js',
  'sim/sensor.js',
  'sim/reconstruct.js',
  'sim/audio.js',
  'sim/main.js',
];

const strip = (src) =>
  src
    .split('\n')
    .filter((l) => !/^\s*import\s.+from\s+['"].+['"];?\s*$/.test(l))
    .map((l) => l.replace(/^(\s*)export\s+(const|let|function|class|async)\b/, '$1$2'))
    .filter((l) => !/^\s*export\s*\{/.test(l))
    .join('\n');

const banner = (path) => `\n// ${'='.repeat(66)}\n// ${path}\n// ${'='.repeat(66)}\n`;

const code = MODULES.map((m) => banner(m) + strip(readFileSync(join(root, m), 'utf8'))).join('\n');

const html = readFileSync(join(root, 'sim/index.html'), 'utf8').replace(
  '<script type="module" src="./main.js"></script>',
  `<script type="module">\n${code}\n</script>`
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
