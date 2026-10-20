/**
 * Friends Events – Prerender-Build für Render.com
 * ------------------------------------------------
 * Erzeugt aus der einen index.html für JEDE Unterseite eine eigene, physische
 * HTML-Datei (z. B. dist/fotospiegel/index.html) mit:
 *   - eigenem <title>, Meta-Description, og:/twitter:-Tags
 *   - selbstreferenzierendem Canonical schon im Quellcode (nicht erst per JS)
 *   - der richtigen Sektion als "page active" (statt der Startseite)
 * Zusätzlich für alle Dateien:
 *   - Navigations-Links mit href="#..." + onclick="show('x')" bekommen echte Pfade
 *   - Schema-URLs wie https://www.friends-events.com/#fotospiegel -> /fotospiegel
 *   - alte Wix-URLs (Aliase aus pathMap) werden zu Sofort-Weiterleitungen
 *
 * Alle Daten (URLs, Titel, Beschreibungen) werden aus der index.html gelesen.
 * Neue Seiten im urlMap/titleMap/descMap werden also automatisch mitgebaut.
 *
 * Render-Einstellungen:  Build Command: node prerender.js   Publish Directory: dist
 * Keine Abhängigkeiten, nur Node-Bordmittel.
 */
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = __dirname;
const OUT = path.join(ROOT, 'dist');
// Hauptdomain: so, wie Render sie ausliefert (www leitet bei Render auf diese Domain um)
const DOMAIN = 'https://friends-events.com';
const ANY_HOST = /https:\/\/(?:www\.)?friends-events\.com/g;
const SKIP = new Set(['dist', '.git', '.github', 'node_modules', 'prerender.js']);

function fail(msg) { console.error('\n[PRERENDER] ABBRUCH: ' + msg + '\n'); process.exit(1); }

// ---------- 1) Quelle lesen ----------
const srcFile = path.join(ROOT, 'index.html');
if (!fs.existsSync(srcFile)) fail('index.html nicht gefunden.');
const SRC = fs.readFileSync(srcFile, 'utf8');

// ---------- 2) JS-Objekte (urlMap, titleMap, descMap, pathMap, hashMap) auslesen ----------
function readMap(name) {
  const start = SRC.indexOf('const ' + name + ' = {');
  if (start === -1) return null;
  const end = SRC.indexOf('};', start);
  const body = SRC.slice(start, end);
  const map = {};
  const re = /'((?:[^'\\]|\\.)*)'\s*:\s*'((?:[^'\\]|\\.)*)'/g;
  let m;
  while ((m = re.exec(body))) map[m[1].replace(/\\'/g, "'")] = m[2].replace(/\\'/g, "'");
  return map;
}
const urlMap = readMap('urlMap');
const titleMap = readMap('titleMap') || {};
const descMap = readMap('descMap') || {};
const pathMap = readMap('pathMap') || {};
const hashMap = readMap('hashMap') || {};
if (!urlMap || !urlMap.home) fail('urlMap konnte nicht gelesen werden.');

// ---------- Hilfsfunktionen ----------
const escAttr = s => s.replace(/&(?!amp;|quot;|lt;|gt;|#)/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function replaceOnce(html, regex, replacement, label) {
  const hits = html.match(new RegExp(regex.source, regex.flags.includes('g') ? regex.flags : regex.flags + 'g'));
  if (!hits || hits.length !== 1) fail(label + ': erwartet 1 Treffer, gefunden ' + (hits ? hits.length : 0));
  return html.replace(regex, replacement);
}

// ---------- 3) Globale Korrekturen (gelten für alle Ausgabedateien) ----------
let base = SRC;

// 3-0) Alle Domain-Varianten (mit/ohne www) auf die eine Hauptdomain vereinheitlichen
const hostFixes = (base.match(ANY_HOST) || []).filter(u => u !== DOMAIN).length;
base = base.replace(ANY_HOST, DOMAIN);

// 3a) Hash-Links mit show('x') -> echte, crawlbare Pfade (Verhalten für Nutzer bleibt gleich)
let linkFixes = 0;
base = base.replace(/<a\b[^>]*>/g, tag => {
  const hrefM = tag.match(/\bhref="(#[^"]*)"/);
  const showM = tag.match(/show\('([^']+)'\)/);
  if (!hrefM || !showM || !urlMap[showM[1]]) return tag;
  linkFixes++;
  return tag.replace(hrefM[0], 'href="' + urlMap[showM[1]] + '"');
});

// 3b) Schema-/Daten-URLs mit Hash-Fragment -> echte Pfade
let schemaFixes = 0;
const hashUrlRe = new RegExp(DOMAIN.replace(/[.\/]/g, '\\$&') + '\\/#([a-z0-9-]+)', 'g');
base = base.replace(hashUrlRe, (all, slug) => {
  const id = hashMap[slug] || (urlMap[slug] ? slug : null);
  if (!id || !urlMap[id]) return all;
  schemaFixes++;
  return DOMAIN + urlMap[id];
});

// ---------- 4) Ausgabeordner vorbereiten & sonstige Dateien kopieren ----------
fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(OUT, { recursive: true });
for (const entry of fs.readdirSync(ROOT)) {
  if (SKIP.has(entry) || entry === 'index.html') continue;
  fs.cpSync(path.join(ROOT, entry), path.join(OUT, entry), { recursive: true });
}
// sitemap.xml und robots.txt ebenfalls auf die Hauptdomain vereinheitlichen
for (const f of ['sitemap.xml', 'robots.txt']) {
  const fp = path.join(OUT, f);
  if (fs.existsSync(fp)) fs.writeFileSync(fp, fs.readFileSync(fp, 'utf8').replace(ANY_HOST, DOMAIN));
}
fs.writeFileSync(path.join(OUT, 'index.html'), base);

// ---------- 5) Eine Datei pro Unterseite ----------
const headEnd = base.indexOf('</head>');
if (headEnd === -1) fail('</head> nicht gefunden.');
const report = [];

for (const [id, urlPath] of Object.entries(urlMap)) {
  if (id === 'home' || urlPath === '/') continue;
  const canonical = DOMAIN + urlPath;
  const title = titleMap[id];
  const desc = descMap[id];
  if (!title) fail('Kein titleMap-Eintrag für "' + id + '".');

  let head = base.slice(0, headEnd);
  let body = base.slice(headEnd);

  head = replaceOnce(head, /<title>[\s\S]*?<\/title>/, '<title>' + escAttr(title) + '</title>', id + ' <title>');
  head = replaceOnce(head, /<link\b[^>]*rel="canonical"[^>]*>/, '<link id="canonical-link" rel="canonical" href="' + canonical + '">', id + ' canonical');
  head = replaceOnce(head, /<meta property="og:url" content="[^"]*">/, '<meta property="og:url" content="' + canonical + '">', id + ' og:url');
  head = replaceOnce(head, /<meta property="og:title" content="[^"]*">/, '<meta property="og:title" content="' + escAttr(title) + '">', id + ' og:title');
  head = head.replace(/<meta name="twitter:title" content="[^"]*">/, '<meta name="twitter:title" content="' + escAttr(title) + '">');
  if (desc) {
    head = replaceOnce(head, /<meta name="description" content="[^"]*">/, '<meta name="description" content="' + escAttr(desc) + '">', id + ' description');
    head = head.replace(/<meta property="og:description" content="[^"]*">/, '<meta property="og:description" content="' + escAttr(desc) + '">');
    head = head.replace(/<meta name="twitter:description" content="[^"]*">/, '<meta name="twitter:description" content="' + escAttr(desc) + '">');
  }

  // Startseite deaktivieren, Zielsektion aktivieren
  body = replaceOnce(body, /class="page active" id="page-home"/, 'class="page" id="page-home"', id + ' home-Sektion');
  const secRe = new RegExp('class="page" id="page-' + id.replace(/[-]/g, '\\-') + '"');
  body = replaceOnce(body, secRe, 'class="page active" id="page-' + id + '"', id + ' Sektion page-' + id);
  body = body.replace(/id="nav-home" class="active"/, 'id="nav-home"');

  const dir = path.join(OUT, urlPath.replace(/^\//, ''));
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'index.html'), head + body);
  report.push(urlPath);
}

// ---------- 6) Alte URLs (Aliase im pathMap) -> Sofort-Weiterleitung ----------
const realPaths = new Set(Object.values(urlMap));
const aliases = [];
for (const [p, id] of Object.entries(pathMap)) {
  if (realPaths.has(p) || !urlMap[id]) continue;
  const target = urlMap[id];
  const html = '<!DOCTYPE html><html lang="de"><head><meta charset="UTF-8">' +
    '<title>Weiterleitung – Friends Events Magdeburg</title>' +
    '<link rel="canonical" href="' + DOMAIN + target + '">' +
    '<meta http-equiv="refresh" content="0; url=' + target + '">' +
    '<script>location.replace("' + target + '")</script></head>' +
    '<body><a href="' + target + '">Weiter zu ' + DOMAIN + target + '</a></body></html>';
  const dir = path.join(OUT, p.replace(/^\//, ''));
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'index.html'), html);
  aliases.push(p + ' -> ' + target);
}

// ---------- 7) Abgleich mit sitemap.xml ----------
const smFile = path.join(ROOT, 'sitemap.xml');
if (fs.existsSync(smFile)) {
  const sm = fs.readFileSync(smFile, 'utf8');
  const smPaths = [...sm.matchAll(/<loc>https:\/\/(?:www\.)?friends-events\.com([^<]*)<\/loc>/g)].map(m => m[1] || '/');
  const missingInSitemap = [...realPaths].filter(p => !smPaths.includes(p));
  const notBuilt = smPaths.filter(p => !realPaths.has(p));
  if (missingInSitemap.length) console.warn('[PRERENDER] WARNUNG – fehlt in sitemap.xml: ' + missingInSitemap.join(', '));
  if (notBuilt.length) console.warn('[PRERENDER] WARNUNG – in sitemap.xml, aber keine Seite: ' + notBuilt.join(', '));
}

console.log('[PRERENDER] OK – ' + report.length + ' Unterseiten + Startseite gebaut.');
console.log('[PRERENDER] Hauptdomain: ' + DOMAIN + ' | Domain-Angaben vereinheitlicht: ' + hostFixes);
console.log('[PRERENDER] Links korrigiert: ' + linkFixes + ' | Schema-URLs korrigiert: ' + schemaFixes);
console.log('[PRERENDER] Weiterleitungen: ' + (aliases.join(' | ') || 'keine'));
