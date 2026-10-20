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


// ---------- 4b) Strukturierte Daten (Schema.org) pro Seite ----------
// Regeln:
//  - Blöcke ohne eigene Unterseiten-URL (LocalBusiness, Organization, WebSite) gelten für alle Seiten.
//  - Blöcke mit Unterseiten-URL (z. B. Service Fotospiegel) erscheinen NUR auf dieser Unterseite.
//  - "Product" wird zu "Service" (Mietangebote sind Dienstleistungen, keine Shop-Artikel).
//  - Bewertungs-Sterne (aggregateRating/review) werden entfernt: die Bewertungen stammen von Google,
//    fremde Bewertungen dürfen laut Google-Richtlinien nicht als eigenes Schema ausgezeichnet werden.
//  - Handgeschriebene FAQPage- und BreadcrumbList-Blöcke werden ersetzt durch automatisch erzeugte,
//    die exakt dem sichtbaren Inhalt der jeweiligen Seite entsprechen (FAQ-Akkordeon, Brotkrümel-Leiste).
//  - WebSite-Suchfunktion wird entfernt (die Website hat keine Suche).
const LD_RE = /<script type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>\s*/g;
const decode = s => s.replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&quot;/g, '"')
  .replace(/&#39;|&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/\s+/g, ' ').trim();
const schemaLog = { removedRatings: 0, productsConverted: 0, logoFixed: false };

function stripRatings(obj) {
  if (Array.isArray(obj)) return obj.forEach(stripRatings);
  if (obj && typeof obj === 'object') {
    for (const k of ['aggregateRating', 'review', 'reviews']) if (k in obj) { delete obj[k]; schemaLog.removedRatings++; }
    Object.values(obj).forEach(stripRatings);
  }
}
function toService(obj) {
  if (obj['@type'] !== 'Product') return obj;
  schemaLog.productsConverted++;
  const s = { '@context': 'https://schema.org', '@type': 'Service', name: obj.name };
  if (obj.description) s.description = obj.description;
  s.provider = { '@type': 'LocalBusiness', name: (obj.brand && obj.brand.name) || 'Friends Events Magdeburg' };
  s.areaServed = { '@type': 'City', name: 'Magdeburg' };
  if (obj.offers) {
    const o = Object.assign({}, obj.offers); delete o.availability;
    s.offers = o;
  }
  if (obj.url) s.url = obj.url;
  return s;
}
function pagePathOf(obj) {
  const u = obj && (obj.url || (obj.offers && obj.offers.url));
  if (!u || typeof u !== 'string' || !u.startsWith(DOMAIN)) return null;
  const p = u.slice(DOMAIN.length).replace(/\/$/, '');
  return p === '' ? null : p;
}

// Quell-Blöcke einmal aus dem Head lesen
const SCHEMA_SRC = [];
{
  const head = base.slice(0, base.indexOf('</head>'));
  let m;
  while ((m = LD_RE.exec(head))) {
    let obj;
    try { obj = JSON.parse(m[1]); } catch (e) { fail('Schema-Block ist kein gültiges JSON: ' + m[1].slice(0, 80)); }
    const t = obj['@type'];
    if (t === 'FAQPage' || t === 'BreadcrumbList') continue;      // wird pro Seite neu erzeugt
    if (t === 'WebSite') delete obj.potentialAction;                // keine Suchfunktion vorhanden
    if (t === 'Organization' && obj.logo && obj.logo.startsWith(DOMAIN)) {
      const lp = obj.logo.slice(DOMAIN.length);
      if (!fs.existsSync(path.join(ROOT, lp)) && fs.existsSync(path.join(ROOT, 'icon-512.png'))) {
        obj.logo = DOMAIN + '/icon-512.png'; schemaLog.logoFixed = true;
      }
    }
    stripRatings(obj);
    obj = toService(obj);
    SCHEMA_SRC.push({ obj, page: pagePathOf(obj) });
  }
}

function sectionHtml(html, id) {
  const start = html.search(new RegExp('<div class="page[^"]*" id="page-' + id.replace(/-/g, '\\-') + '"'));
  if (start === -1) return '';
  const next = html.slice(start + 10).search(/<div class="page[^"]*" id="page-/);
  return next === -1 ? html.slice(start) : html.slice(start, start + 10 + next);
}
function breadcrumbFor(sec, urlPath) {
  const m = sec.match(/<div class="bc"[^>]*>([\s\S]*?)<\/div>/);
  if (!m) return null;
  const items = [];
  const re = /<a\b[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>|<span>([\s\S]*?)<\/span>/g;
  let x;
  while ((x = re.exec(m[1]))) {
    if (x[1]) items.push({ name: decode(x[2]), item: DOMAIN + (x[1] === '/' ? '/' : x[1]) });
    else items.push({ name: decode(x[3]), item: DOMAIN + urlPath });
  }
  if (items.length < 2) return null;
  return { '@context': 'https://schema.org', '@type': 'BreadcrumbList',
    itemListElement: items.map((it, i) => ({ '@type': 'ListItem', position: i + 1, name: it.name, item: it.item })) };
}
function faqFor(sec) {
  const re = /<details class="faq-item">\s*<summary>([\s\S]*?)<\/summary>\s*<div class="faq-item-body">([\s\S]*?)<\/div>\s*<\/details>/g;
  const qa = []; let x;
  while ((x = re.exec(sec))) qa.push({ '@type': 'Question', name: decode(x[1]), acceptedAnswer: { '@type': 'Answer', text: decode(x[2]) } });
  return qa.length ? { '@context': 'https://schema.org', '@type': 'FAQPage', mainEntity: qa } : null;
}
function applySchema(html, id, urlPath) {
  const he = html.indexOf('</head>');
  let head = html.slice(0, he);
  const firstLd = head.search(LD_RE);
  head = head.replace(LD_RE, '');
  const sec = sectionHtml(html, id);
  const blocks = SCHEMA_SRC.filter(b => b.page === null || b.page === urlPath).map(b => b.obj);
  const bc = id === 'home' ? null : breadcrumbFor(sec, urlPath);
  if (bc) blocks.push(bc);
  const faq = faqFor(sec);
  if (faq) blocks.push(faq);
  const out = blocks.map(b => '<script type="application/ld+json">\n' + JSON.stringify(b, null, 2) + '\n</script>\n').join('');
  const at = firstLd === -1 ? head.length : firstLd;
  return { html: head.slice(0, at) + out + head.slice(at) + html.slice(he),
           types: blocks.map(b => b['@type'] + (b['@type'] === 'Service' ? '(' + b.name + ')' : '')) };
}

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
const homeOut = applySchema(base, 'home', '/');
fs.writeFileSync(path.join(OUT, 'index.html'), homeOut.html);
const schemaReport = ['/ : ' + homeOut.types.join(', ')];

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
  const pageOut = applySchema(head + body, id, urlPath);
  fs.writeFileSync(path.join(dir, 'index.html'), pageOut.html);
  schemaReport.push(urlPath + ' : ' + pageOut.types.join(', '));
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
console.log('[PRERENDER] Schema: ' + schemaLog.productsConverted + ' Product->Service | ' + schemaLog.removedRatings + ' Bewertungs-Angaben entfernt' + (schemaLog.logoFixed ? ' | Logo -> icon-512.png' : ''));
if (process.env.SCHEMA_REPORT) console.log(schemaReport.join('\n'));
