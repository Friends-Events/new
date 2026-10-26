/**
 * Friends Events – Prerender-Build für Render.com  (Version 2, Stand 26.10.2026)
 * ---------------------------------------------------------------------------
 * Erzeugt aus der einen index.html für JEDE Unterseite eine eigene, physische
 * HTML-Datei (z. B. dist/fotospiegel/index.html).
 *
 * NEU in Version 2 – jede Seite ist jetzt wirklich eigenständig:
 *   - Jede Datei enthält NUR ihre eigene Sektion (plus Kopfbereich, Menü und Footer).
 *     Vorher steckte in jeder Datei der Inhalt aller Seiten -> Google hielt die
 *     Unterseiten für Kopien voneinander und zeigte z. B. bei "Fotospiegel" die Kontaktseite.
 *   - Dadurch genau eine H1 pro Seite und deutlich kleinere Dateien
 *     (Bilder anderer Seiten und Partner-Logos fallen weg, wo sie nicht gebraucht werden).
 *   - Menü-Links sind normale Links (echter Seitenaufruf statt JavaScript-Umschalten).
 *   - "Jetzt buchen"-Buttons auf Unterseiten springen zur Kontaktseite und
 *     übernehmen dort Modul, Paket und Vermietungsart wie bisher.
 *   - Eigene 404-Seite (Render liefert sie für unbekannte Adressen mit Status 404 aus).
 *   - sitemap.xml wird beim Build mit den tatsächlich gebauten Seiten abgeglichen.
 *   - Favicons aus dem Repo werden automatisch im <head> eingetragen.
 *   - Abschlussprüfung: genau 1 Sektion, 1 H1, eigener Titel und Canonical pro Seite.
 *
 * Unverändert aus Version 1:
 *   - eigener <title>, Meta-Description, og:/twitter:-Tags, selbstreferenzierender Canonical
 *   - Hash-Links (#x + show('x')) werden zu echten Pfaden
 *   - Schema-URLs mit Hash -> echte Pfade, Schema pro Seite (Service, Breadcrumb, FAQ)
 *   - alte Wix-URLs (Aliase aus pathMap) werden zu Sofort-Weiterleitungen
 *
 * Alle Daten (URLs, Titel, Beschreibungen) werden aus der index.html gelesen.
 * Neue Seite = Eintrag in urlMap/titleMap/descMap + Sektion <div class="page" id="page-...">.
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
const SKIP = new Set(['dist', '.git', '.github', 'node_modules', 'prerender.js', 'README.md']);
const TODAY = new Date().toISOString().slice(0, 10);

function fail(msg) { console.error('\n[PRERENDER] ABBRUCH: ' + msg + '\n'); process.exit(1); }
const warnings = [];
function warn(msg) { warnings.push(msg); console.warn('[PRERENDER] WARNUNG – ' + msg); }

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
function readList(name) {
  const m = SRC.match(new RegExp('const ' + name + '\\s*=\\s*\\[([^\\]]*)\\]'));
  return m ? [...m[1].matchAll(/'([^']+)'/g)].map(x => x[1]) : [];
}
const urlMap = readMap('urlMap');
const titleMap = readMap('titleMap') || {};
const descMap = readMap('descMap') || {};
const pathMap = readMap('pathMap') || {};
const hashMap = readMap('hashMap') || {};
const SUB = readList('SUB');
if (!urlMap || !urlMap.home) fail('urlMap konnte nicht gelesen werden.');

// ---------- Hilfsfunktionen ----------
const escAttr = s => s.replace(/&(?!amp;|quot;|lt;|gt;|#)/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const escRe = s => s.replace(/[.*+?^${}()|[\]\\\/-]/g, '\\$&');

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

// 3a) Hash-Links mit show('x') -> echte, crawlbare Pfade
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
const hashUrlRe = new RegExp(escRe(DOMAIN) + '\\/#([a-z0-9-]+)', 'g');
base = base.replace(hashUrlRe, (all, slug) => {
  const id = hashMap[slug] || (urlMap[slug] ? slug : null);
  if (!id || !urlMap[id]) return all;
  schemaFixes++;
  return DOMAIN + urlMap[id];
});

// 3c) NEU: Links mit echtem Pfad laden die Seite normal (onclick="show(...)" entfernen).
//     Jede Seite ist jetzt eine eigene Datei – der Klick soll sie wirklich aufrufen.
let onclickRemoved = 0;
base = base.replace(/<a\b[^>]*>/g, tag => {
  const href = (tag.match(/\bhref="([^"]*)"/) || [])[1] || '';
  const oc = tag.match(/\sonclick="([^"]*)"/);
  if (!href.startsWith('/') || !oc || !/show\('/.test(oc[1])) return tag;
  const rest = oc[1].replace(/show\('[^']*'\)/g, '').replace(/toggleMobileMenu\(\)/g, '')
    .replace(/return\s+false/g, '').replace(/[;\s]/g, '');
  if (rest !== '') return tag;              // weitere Funktionen im onclick -> lieber unverändert lassen
  onclickRemoved++;
  return tag.replace(oc[0], '');
});

// 3d) NEU: Favicons automatisch eintragen, wenn die Dateien im Repo liegen und im <head> nichts steht
const FAVICONS = [
  ['favicon.ico', '<link rel="icon" href="/favicon.ico" sizes="any">'],
  ['favicon.svg', '<link rel="icon" href="/favicon.svg" type="image/svg+xml">'],
  ['favicon-16x16.png', '<link rel="icon" href="/favicon-16x16.png" type="image/png" sizes="16x16">'],
  ['favicon-32x32.png', '<link rel="icon" href="/favicon-32x32.png" type="image/png" sizes="32x32">'],
  ['favicon-32.png', '<link rel="icon" href="/favicon-32.png" type="image/png" sizes="32x32">'],
  ['favicon-48x48.png', '<link rel="icon" href="/favicon-48x48.png" type="image/png" sizes="48x48">'],
  ['favicon-96x96.png', '<link rel="icon" href="/favicon-96x96.png" type="image/png" sizes="96x96">'],
  ['icon-192.png', '<link rel="icon" href="/icon-192.png" type="image/png" sizes="192x192">'],
  ['android-chrome-192x192.png', '<link rel="icon" href="/android-chrome-192x192.png" type="image/png" sizes="192x192">'],
  ['icon-512.png', '<link rel="icon" href="/icon-512.png" type="image/png" sizes="512x512">'],
  ['android-chrome-512x512.png', '<link rel="icon" href="/android-chrome-512x512.png" type="image/png" sizes="512x512">'],
  ['apple-touch-icon.png', '<link rel="apple-touch-icon" href="/apple-touch-icon.png" sizes="180x180">'],
  ['site.webmanifest', '<link rel="manifest" href="/site.webmanifest">'],
  ['manifest.json', '<link rel="manifest" href="/manifest.json">'],
];
let faviconInfo = 'im <head> vorhanden';
{
  const headPart = base.slice(0, base.indexOf('</head>'));
  if (!/<link\b[^>]*rel="(?:shortcut )?icon"/i.test(headPart)) {
    const found = FAVICONS.filter(([f]) => fs.existsSync(path.join(ROOT, f)));
    if (found.length) {
      base = base.replace(/<meta name="viewport"[^>]*>/, m => m + '\n' + found.map(x => x[1]).join('\n'));
      faviconInfo = 'eingetragen: ' + found.map(x => x[0]).join(', ');
    } else {
      faviconInfo = 'KEINE Favicon-Datei im Repo gefunden';
      warn('Kein Favicon im <head> und keine Favicon-Datei im Repo (z. B. favicon.ico).');
    }
  }
}

// ---------- 4) Seite in Kopf, Sektionen und Fuß zerlegen ----------
// Sektionen werden über ihre öffnenden/schließenden <div>-Tags exakt abgegrenzt
// (so, wie der Browser sie liest – überzählige </div> zwischen den Sektionen werden ignoriert).
const DIV_TOKEN = /<!--[\s\S]*?-->|<div\b[^>]*>|<\/div\s*>/gi;
function blockEnd(html, start) {
  DIV_TOKEN.lastIndex = start;
  let depth = 0, m;
  while ((m = DIV_TOKEN.exec(html))) {
    const g = m[0];
    if (g.startsWith('<!--')) continue;
    if (g[1] === '/') { depth--; if (depth === 0) return DIV_TOKEN.lastIndex; }
    else depth++;
  }
  return -1;
}
const SECTION_RE = /<div class="page(?: active)?" id="page-([a-z0-9-]+)"[^>]*>/g;
const SECTIONS = {};
let firstStart = -1, lastEnd = -1;
{
  let m;
  while ((m = SECTION_RE.exec(base))) {
    const end = blockEnd(base, m.index);
    if (end === -1) fail('Ende der Sektion page-' + m[1] + ' nicht gefunden (div-Struktur prüfen).');
    if (firstStart === -1) firstStart = m.index;
    if (SECTIONS[m[1]]) fail('Sektion page-' + m[1] + ' kommt doppelt vor.');
    SECTIONS[m[1]] = base.slice(m.index, end).replace(/^<div class="page(?: active)?"/, '<div class="page active"');
    lastEnd = end;
    SECTION_RE.lastIndex = end;                 // nächste Suche erst hinter dieser Sektion
  }
}
if (firstStart === -1) fail('Keine Sektionen <div class="page" id="page-..."> gefunden.');
const headEnd = base.indexOf('</head>');
if (headEnd === -1 || headEnd > firstStart) fail('</head> nicht gefunden.');
const HEAD = base.slice(0, headEnd);
const BODY_START = base.slice(headEnd, firstStart);       // </head><body> … Menü
const BODY_END = base.slice(lastEnd);                      // Footer, Skripte, </body></html>

for (const id of Object.keys(urlMap)) if (!SECTIONS[id]) fail('Sektion page-' + id + ' fehlt für urlMap-Eintrag "' + id + '".');
for (const id of Object.keys(SECTIONS)) if (!urlMap[id]) warn('Sektion page-' + id + ' hat keinen urlMap-Eintrag und wird nicht gebaut.');

// ---------- 5) Strukturierte Daten (Schema.org) pro Seite ----------
// Regeln:
//  - Blöcke ohne eigene Unterseiten-URL (LocalBusiness, Organization, WebSite) gelten für alle Seiten.
//  - Blöcke mit Unterseiten-URL (z. B. Service Fotospiegel) erscheinen NUR auf dieser Unterseite.
//  - "Product" wird zu "Service" (Mietangebote sind Dienstleistungen, keine Shop-Artikel).
//  - Bewertungs-Sterne (aggregateRating/review) werden entfernt: die Bewertungen stammen von Google,
//    fremde Bewertungen dürfen laut Google-Richtlinien nicht als eigenes Schema ausgezeichnet werden.
//  - FAQPage und BreadcrumbList werden pro Seite aus dem sichtbaren Inhalt erzeugt.
//  - WebSite-Suchfunktion wird entfernt (die Website hat keine Suche).
const LD_RE = /<script type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>\s*/g;
const decode = s => s.replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&quot;/g, '"')
  .replace(/&#39;|&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&auml;/g, 'ä').replace(/&ouml;/g, 'ö')
  .replace(/&uuml;/g, 'ü').replace(/&Auml;/g, 'Ä').replace(/&Ouml;/g, 'Ö').replace(/&Uuml;/g, 'Ü').replace(/&szlig;/g, 'ß')
  .replace(/&rarr;/g, '→').replace(/&ndash;/g, '–').replace(/&mdash;/g, '—').replace(/\s+/g, ' ').trim();
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

const SCHEMA_SRC = [];
{
  let m;
  LD_RE.lastIndex = 0;
  while ((m = LD_RE.exec(HEAD))) {
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
function schemaBlocks(id, urlPath, sec) {
  const blocks = SCHEMA_SRC.filter(b => b.page === null || b.page === urlPath).map(b => b.obj);
  const bc = id === 'home' ? null : breadcrumbFor(sec, urlPath);
  if (bc) blocks.push(bc);
  const faq = faqFor(sec);
  if (faq) blocks.push(faq);
  return blocks;
}
function applySchema(head, blocks) {
  LD_RE.lastIndex = 0;
  const firstLd = head.search(LD_RE);
  head = head.replace(LD_RE, '');
  const out = blocks.map(b => '<script type="application/ld+json">\n' + JSON.stringify(b, null, 2) + '\n</script>\n').join('');
  const at = firstLd === -1 ? head.length : firstLd;
  return head.slice(0, at) + out + head.slice(at);
}

// ---------- 6) Laufzeit-Skript für die Einzelseiten ----------
// Wird vor </body> eingefügt. Sorgt dafür, dass die vorhandenen Funktionen (show, bookNow)
// auf Einzelseiten richtig arbeiten, ohne dass die index.html geändert werden muss.
const RUNTIME = '<script>\n/* Prerender-Laufzeit: jede Unterseite ist eine eigene Datei */\n(function(){\n' +
  '  var U=' + JSON.stringify(urlMap) + ';\n' +
  '  var same=function(u){try{var a=new URL(u,location.href);return a.pathname.replace(/\\/$/,"")===location.pathname.replace(/\\/$/,"");}catch(e){return false;}};\n' +
  '  try{var _push=history.pushState.bind(history);history.pushState=function(s,t,u){if(u!=null&&same(u))return history.replaceState(s,t,u);return _push(s,t,u);};}catch(e){}\n' +
  '  var _show=window.show;\n' +
  '  if(typeof _show==="function"){window.show=function(id){if(!document.getElementById("page-"+id)){if(U[id])location.href=U[id];return;}return _show.apply(this,arguments);};}\n' +
  '  var _book=window.bookNow;\n' +
  '  if(typeof _book==="function"){window.bookNow=function(m,p,v){if(!document.getElementById("page-kontakt")){location.href=U.kontakt+"#anfrage="+[m,p,v].map(function(x){return encodeURIComponent(x||"");}).join(",");return;}return _book.apply(this,arguments);};}\n' +
  '  if(document.getElementById("page-kontakt")){var h=location.hash.match(/^#anfrage=([^,]*),([^,]*),(.*)$/);if(h){var args=h.slice(1).map(decodeURIComponent);try{history.replaceState(history.state,"",location.pathname);}catch(e){}document.addEventListener("DOMContentLoaded",function(){window.bookNow.apply(window,args);});}}\n' +
  '  window.addEventListener("popstate",function(e){var p=e.state&&e.state.page;if(p&&!document.getElementById("page-"+p))location.reload();});\n' +
  '})();\n</script>\n';

// ---------- 7) Eine Seite zusammenbauen ----------
const HERO_PRELOAD_RE = /<link rel="preload" href="([^"]+)" as="image">\s*/g;
const LOGO_VAR_RE = /(--logo-[a-z0-9-]+:)url\((['"]?)data:image\/[^)'"]+\2\)/g;

function pruneImageMap(bodyEnd, sec) {
  // Bilder, die über data-i="iX" mehrfach genutzt werden, nur mitliefern, wenn die Seite sie braucht
  const used = new Set([...sec.matchAll(/data-i="(i\d+)"/g)].map(m => m[1]));
  return bodyEnd.replace(/var I=\{([\s\S]*?)\};var l=document/, (all, inner) => {
    const kept = [...inner.matchAll(/(i\d+):"([^"]*)"/g)].filter(m => used.has(m[1])).map(m => m[1] + ':"' + m[2] + '"');
    return 'var I={' + kept.join(',') + '};var l=document';
  });
}
function setNavActive(bodyStart, id) {
  let out = bodyStart.replace(/<a\b[^>]*\bid="nav-[a-z0-9-]+"[^>]*>/g, tag =>
    tag.replace(/\sclass="active"/, '').replace(/\sclass="([^"]*)\bactive\b([^"]*)"/, (a, x, y) => ' class="' + (x + y).trim() + '"'));
  const target = new RegExp('id="nav-' + escRe(id) + '"').test(out) ? id : (SUB.includes(id) ? 'angebote' : null);
  if (target) {
    out = out.replace(new RegExp('<a\\b[^>]*\\bid="nav-' + escRe(target) + '"[^>]*>'), tag =>
      /\sclass="/.test(tag) ? tag.replace(/\sclass="([^"]*)"/, (a, c) => ' class="' + (c + ' active').trim() + '"') : tag.replace(/^<a\b/, '<a class="active"'));
  }
  return out;
}
function pageOgImage(head, sec) {
  // Erstes echtes Bild (https) der Seite als Vorschaubild für WhatsApp, Facebook & Co.
  const img = sec.match(/<img\b[^>]*\bsrc="(https:\/\/[^"]+)"[^>]*>/);
  if (!img) return head;
  const alt = (img[0].match(/\balt="([^"]*)"/) || [])[1] || '';
  head = head.replace(/<meta property="og:image" content="[^"]*">/, '<meta property="og:image" content="' + img[1] + '">');
  head = head.replace(/<meta name="twitter:image" content="[^"]*">/, '<meta name="twitter:image" content="' + img[1] + '">');
  head = head.replace(/\s*<meta property="og:image:(?:width|height)" content="[^"]*">/g, '');
  if (alt) head = head.replace(/<meta property="og:image:alt" content="[^"]*">/, '<meta property="og:image:alt" content="' + alt + '">');
  return head;
}

function buildPage(id, urlPath) {
  const sec = SECTIONS[id];
  const canonical = DOMAIN + urlPath;
  const title = titleMap[id];
  const desc = descMap[id];
  if (!title) fail('Kein titleMap-Eintrag für "' + id + '".');

  let head = HEAD;
  head = replaceOnce(head, /<title>[\s\S]*?<\/title>/, '<title>' + escAttr(title) + '</title>', id + ' <title>');
  head = replaceOnce(head, /<link\b[^>]*rel="canonical"[^>]*>/, '<link id="canonical-link" rel="canonical" href="' + canonical + '">', id + ' canonical');
  head = replaceOnce(head, /<meta property="og:url" content="[^"]*">/, '<meta property="og:url" content="' + canonical + '">', id + ' og:url');
  head = replaceOnce(head, /<meta property="og:title" content="[^"]*">/, '<meta property="og:title" content="' + escAttr(title) + '">', id + ' og:title');
  head = head.replace(/<meta name="twitter:title" content="[^"]*">/, '<meta name="twitter:title" content="' + escAttr(title) + '">');
  if (desc) {
    head = replaceOnce(head, /<meta name="description" content="[^"]*">/, '<meta name="description" content="' + escAttr(desc) + '">', id + ' description');
    head = head.replace(/<meta property="og:description" content="[^"]*">/, '<meta property="og:description" content="' + escAttr(desc) + '">');
    head = head.replace(/<meta name="twitter:description" content="[^"]*">/, '<meta name="twitter:description" content="' + escAttr(desc) + '">');
  } else warn('Keine descMap-Beschreibung für "' + id + '".');

  // Ballast entfernen, den diese Seite nicht braucht
  head = head.replace(HERO_PRELOAD_RE, (all, href) => sec.includes(href) ? all : '');
  if (!/partner-logo/.test(sec)) head = head.replace(LOGO_VAR_RE, '$1none');
  if (id !== 'home') head = pageOgImage(head, sec);

  head = applySchema(head, schemaBlocks(id, urlPath, sec));

  let bodyStart = BODY_START.replace(/<body class="routing">/, '<body>');
  bodyStart = setNavActive(bodyStart, id);
  let bodyEnd = pruneImageMap(BODY_END, sec);
  bodyEnd = bodyEnd.replace(/<\/body>/, RUNTIME + '</body>');

  return { html: head + bodyStart + sec + '\n' + bodyEnd, sec };
}

// ---------- 8) Ausgabeordner vorbereiten & sonstige Dateien kopieren ----------
fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(OUT, { recursive: true });
for (const entry of fs.readdirSync(ROOT)) {
  if (SKIP.has(entry) || entry === 'index.html' || entry === '404.html') continue;
  fs.cpSync(path.join(ROOT, entry), path.join(OUT, entry), { recursive: true });
}
const rb = path.join(OUT, 'robots.txt');
if (fs.existsSync(rb)) fs.writeFileSync(rb, fs.readFileSync(rb, 'utf8').replace(ANY_HOST, DOMAIN));
else warn('robots.txt fehlt im Repo.');

// ---------- 9) Alle Seiten bauen ----------
const built = [];
const checks = [];
for (const [id, urlPath] of Object.entries(urlMap)) {
  const page = buildPage(id, urlPath);
  const file = urlPath === '/' ? path.join(OUT, 'index.html') : path.join(OUT, urlPath.replace(/^\//, ''), 'index.html');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, page.html);
  built.push(urlPath);
  checks.push({ id, urlPath, html: page.html });
}

// ---------- 10) 404-Seite ----------
{
  const sec = '<div class="page active" id="page-404">\n<section class="sec"><div class="inner" style="text-align:center;padding:6rem 0">\n' +
    '  <div class="sec-hd ctr"><div class="eyebrow">Fehler 404</div>\n' +
    '  <h1 class="sec-title">Diese Seite gibt es leider nicht</h1></div>\n' +
    '  <p style="max-width:560px;margin:0 auto 2rem;color:var(--mu)">Vielleicht hat sich die Adresse geändert. Hier geht es weiter:</p>\n' +
    '  <p style="display:flex;gap:.8rem;justify-content:center;flex-wrap:wrap"><a class="btn-p" href="/">Zur Startseite</a> <a class="btn-s" href="/angebote">Alle Angebote</a> <a class="btn-s" href="/kontakt">Kontakt</a></p>\n' +
    '</div></section>\n</div>';
  let head = HEAD.replace(/<title>[\s\S]*?<\/title>/, '<title>Seite nicht gefunden | Friends Events Magdeburg</title>')
    .replace(/<link\b[^>]*rel="canonical"[^>]*>\s*/, '')
    .replace(/<meta name="robots" content="[^"]*">/, '<meta name="robots" content="noindex, follow">')
    .replace(LD_RE, '').replace(HERO_PRELOAD_RE, '').replace(LOGO_VAR_RE, '$1none');
  if (!/name="robots"/.test(head)) head = head.replace(/<meta charset="UTF-8">/, '<meta charset="UTF-8">\n<meta name="robots" content="noindex, follow">');
  const bodyStart = setNavActive(BODY_START.replace(/<body class="routing">/, '<body>'), '404');
  const bodyEnd = pruneImageMap(BODY_END, sec).replace(/<\/body>/, RUNTIME + '</body>');
  fs.writeFileSync(path.join(OUT, '404.html'), head + bodyStart + sec + '\n' + bodyEnd);
}

// ---------- 11) Alte URLs (Aliase im pathMap) -> Sofort-Weiterleitung ----------
const realPaths = new Set(Object.values(urlMap));
const aliases = [];
for (const [p, id] of Object.entries(pathMap)) {
  if (realPaths.has(p) || !urlMap[id]) continue;
  const target = urlMap[id];
  const html = '<!DOCTYPE html><html lang="de"><head><meta charset="UTF-8">' +
    '<title>Weiterleitung – Friends Events Magdeburg</title>' +
    '<meta name="robots" content="noindex, follow">' +
    '<link rel="canonical" href="' + DOMAIN + target + '">' +
    '<meta http-equiv="refresh" content="0; url=' + target + '">' +
    '<script>location.replace("' + target + '")</script></head>' +
    '<body><a href="' + target + '">Weiter zu ' + DOMAIN + target + '</a></body></html>';
  const dir = path.join(OUT, p.replace(/^\//, ''));
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'index.html'), html);
  aliases.push(p + ' -> ' + target);
}

// ---------- 12) sitemap.xml: exakt die gebauten Seiten ----------
// Daten (lastmod) kommen aus der sitemap.xml im Repo. Fehlt dort eine gebaute Seite, wird sie mit
// dem heutigen Datum ergänzt; Einträge ohne gebaute Seite fliegen raus.
let sitemapInfo;
{
  const smFile = path.join(ROOT, 'sitemap.xml');
  const lastmod = {};
  if (fs.existsSync(smFile)) {
    const sm = fs.readFileSync(smFile, 'utf8');
    for (const m of sm.matchAll(/<url>([\s\S]*?)<\/url>/g)) {
      const loc = (m[1].match(/<loc>https:\/\/(?:www\.)?friends-events\.com([^<]*)<\/loc>/) || [])[1];
      if (loc === undefined) continue;
      const p = (loc === '' ? '/' : loc.replace(/(.)\/$/, '$1'));
      lastmod[p] = (m[1].match(/<lastmod>([^<]+)<\/lastmod>/) || [])[1] || null;
    }
  } else warn('sitemap.xml fehlt im Repo – wird komplett neu erzeugt.');
  const added = built.filter(p => !(p in lastmod));
  const dropped = Object.keys(lastmod).filter(p => !realPaths.has(p));
  if (added.length) warn('in sitemap.xml ergänzt (Datum ' + TODAY + '): ' + added.join(', '));
  if (dropped.length) warn('aus sitemap.xml entfernt (keine Seite): ' + dropped.join(', '));
  const xml = '<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n' +
    built.map(p => '  <url>\n    <loc>' + DOMAIN + p + '</loc>\n    <lastmod>' + (lastmod[p] || TODAY) + '</lastmod>\n  </url>\n').join('') +
    '</urlset>\n';
  fs.writeFileSync(path.join(OUT, 'sitemap.xml'), xml);
  sitemapInfo = built.length + ' URLs';
}

// ---------- 13) Abschlussprüfung ----------
{
  const titles = {}, descs = {};
  for (const c of checks) {
    const h = c.html;
    const sections = (h.match(/<div class="page[^"]*" id="page-/g) || []).length;
    const h1 = (h.match(/<h1\b/gi) || []).length;
    const canon = (h.match(/<link\b[^>]*rel="canonical"[^>]*href="([^"]+)"/) || [])[1];
    const title = (h.match(/<title>([\s\S]*?)<\/title>/) || [])[1];
    const desc = (h.match(/<meta name="description" content="([^"]*)"/) || [])[1];
    if (sections !== 1) fail(c.urlPath + ': ' + sections + ' Sektionen statt 1.');
    if (canon !== DOMAIN + c.urlPath) fail(c.urlPath + ': Canonical stimmt nicht (' + canon + ').');
    if (h1 !== 1) warn(c.urlPath + ': ' + h1 + ' H1-Überschriften (Soll: genau 1).');
    (titles[title] = titles[title] || []).push(c.urlPath);
    (descs[desc] = descs[desc] || []).push(c.urlPath);
    c.kb = Math.round(Buffer.byteLength(h) / 1024);
  }
  for (const [t, ps] of Object.entries(titles)) if (ps.length > 1) warn('gleicher Titel auf ' + ps.join(', ') + ': ' + t);
  for (const [d, ps] of Object.entries(descs)) if (ps.length > 1) warn('gleiche Beschreibung auf ' + ps.join(', '));
}

const srcKb = Math.round(Buffer.byteLength(SRC) / 1024);
const avgKb = Math.round(checks.reduce((a, c) => a + c.kb, 0) / checks.length);
console.log('[PRERENDER] OK – ' + checks.length + ' Seiten gebaut (je 1 Sektion, eigener Titel & Canonical) + 404-Seite.');
console.log('[PRERENDER] Dateigröße: Quelle ' + srcKb + ' KB -> Seiten im Schnitt ' + avgKb + ' KB (min ' +
  Math.min(...checks.map(c => c.kb)) + ' / max ' + Math.max(...checks.map(c => c.kb)) + ' KB)');
console.log('[PRERENDER] Hauptdomain: ' + DOMAIN + ' | Domain-Angaben vereinheitlicht: ' + hostFixes);
console.log('[PRERENDER] Links: ' + linkFixes + ' Hash-Links -> Pfade | ' + onclickRemoved + ' Links auf normalen Seitenaufruf umgestellt | Schema-URLs: ' + schemaFixes);
console.log('[PRERENDER] Favicons: ' + faviconInfo);
console.log('[PRERENDER] Sitemap: ' + sitemapInfo + ' | Weiterleitungen: ' + (aliases.join(' | ') || 'keine'));
console.log('[PRERENDER] Schema: ' + schemaLog.productsConverted + ' Product->Service | ' + schemaLog.removedRatings + ' Bewertungs-Angaben entfernt' + (schemaLog.logoFixed ? ' | Logo -> icon-512.png' : ''));
console.log('[PRERENDER] Hinweise: ' + warnings.length);
if (process.env.SCHEMA_REPORT) for (const c of checks) {
  const types = [...c.html.matchAll(/<script type="application\/ld\+json">\s*\{\s*"@context": "https:\/\/schema\.org",\s*"@type": "([^"]+)"/g)].map(m => m[1]);
  console.log('  ' + c.urlPath + ' (' + c.kb + ' KB): ' + types.join(', '));
}
