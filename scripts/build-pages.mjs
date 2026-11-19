// בונה דפי HTML סטטיים לכל סדרה ולכל שיעור, ומפת אתר מלאה, כדי שגוגל יוכל לקרוא ולאנדקס אותם.
// האתר הראשי (index.html) נבנה בדפדפן מתוך data/lessons.js, ולכן גוגל לא רואה בו את השיעורים עצמם.
// רץ ב-GitHub Action לפני הפרסום. הדפים לא נשמרים בריפו (ראו .gitignore).
// הפעלה מקומית: node scripts/build-pages.mjs
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const SITE = "https://ginzei-haim.org";
const SITE_NAME = "גנזי חיים";
const RABBI = "הרב יואל חקון";
const RABBI_EN = "Rabbi Joel Hakoune";
const CLOSED_PLACES = { "בית וגן אוהל משה": "אוהל משה" };

function loadWindowVar(file, name){
  const p = path.join(ROOT, file);
  if(!fs.existsSync(p)) return null;
  const ctx = { window: {} };
  vm.runInNewContext(fs.readFileSync(p, "utf8"), ctx);
  return ctx.window[name] || null;
}

const DATA = loadWindowVar("data/lessons.js", "LESSONS_DATA") || { categories: [], playlists: [], uploads: [], videos: {} };
const MEDIA = loadWindowVar("data/media.js", "MEDIA_DATA") || { base: "", files: {} };
const EXTRA = MEDIA.base && MEDIA.extra ? MEDIA.extra : { videos: {}, playlists: [] };
const VIDEOS = { ...(DATA.videos || {}), ...EXTRA.videos };
// published = תאריך השיעור (v.date אם נמצא בכותרת/שם הקובץ), uploaded = יום ההעלאה ליוטיוב
for (const v of Object.values(VIDEOS)) { v.uploaded = v.published; if (v.date) v.published = v.date; }
const CAT_LABEL = Object.fromEntries((DATA.categories || []).map(c => [c.key, c.label]));
const PLAYLISTS = [...(DATA.playlists || []), ...EXTRA.playlists]
  .map(p => ({ ...p, ids: p.videoIds.filter(id => VIDEOS[id]) }))
  .filter(p => p.ids.length);

const validKey = (k) => typeof k === "string" && k.trim() !== "" && !k.endsWith("/");
const mediaUrl = (key) => MEDIA.base + "/" + key.split("/").map(encodeURIComponent).join("/");
function mediaOf(id){
  const f = MEDIA.base && MEDIA.files && MEDIA.files[id];
  if(!f) return null;
  const a = validKey(f.a) ? f.a : "";
  const p = (Array.isArray(f.p) ? f.p : []).filter(validKey);
  return a || p.length ? { a, p } : null;
}

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
// JSON בתוך <script>: מונעים סגירה מוקדמת של התגית
const jsonLd = (obj) => `<script type="application/ld+json">${JSON.stringify(obj).replace(/</g, "\\u003c")}</script>`;
const placeLabel = (pl) => CLOSED_PLACES[pl] || pl;
const seriesPath = (p) => `/series/${encodeURIComponent(p.id)}/`;
const lessonPath = (id) => `/lesson/${encodeURIComponent(id)}/`;

function isoDuration(d){
  if(!d) return null;
  const parts = String(d).split(":").map(Number);
  if(parts.some(isNaN)) return null;
  while(parts.length < 3) parts.unshift(0);
  const [h, m, s] = parts;
  return `PT${h ? h + "H" : ""}${m ? m + "M" : ""}${s || (!h && !m) ? s + "S" : ""}`;
}
function hebDate(iso){
  if(!iso) return "";
  const [y, m, d] = iso.slice(0, 10).split("-");
  return `${Number(d)}.${Number(m)}.${y}`;
}
function prettyDuration(d){
  if(!d) return "";
  const parts = String(d).split(":").map(Number);
  while(parts.length < 3) parts.unshift(0);
  const [h, m] = parts;
  if(h) return `${h} שעות${m ? " ו-" + m + " דקות" : ""}`.replace(/^1 שעות/, "שעה");
  return `${m || 1} דקות`;
}
const truncate = (s, n) => s.length > n ? s.slice(0, n - 1).trimEnd() + "…" : s;

// הסדרות של כל שיעור (שיעור יכול להופיע ביותר מסדרה אחת)
const seriesOf = {};
for(const p of PLAYLISTS) for(const id of p.ids) (seriesOf[id] ||= []).push(p);

const PERSON = {
  "@type": "Person",
  "@id": SITE + "/#rabbi",
  name: RABBI,
  alternateName: ["יואל חקון", "הרב יואל חקון שליט\"א", "שיעורי הרב יואל חקון", "Joel Hakoune", RABBI_EN, "Rav Yoel Hakoune"],
  jobTitle: "רב ומלמד קבלה",
  knowsAbout: ["קבלה", "חכמת הקבלה", "כוונות התפילה"],
};

function page({ title, description, canonical, ogType = "website", image, ld = [], body, robots }){
  const img = image || SITE + "/assets/og.jpg";
  return `<!DOCTYPE html>
<html lang="he" dir="rtl">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${esc(title)}</title>
<meta name="description" content="${esc(description)}">
${robots ? `<meta name="robots" content="${robots}">\n` : ""}<link rel="canonical" href="${esc(canonical)}">
<meta property="og:type" content="${ogType}">
<meta property="og:site_name" content="${SITE_NAME}">
<meta property="og:locale" content="he_IL">
<meta property="og:url" content="${esc(canonical)}">
<meta property="og:title" content="${esc(title)}">
<meta property="og:description" content="${esc(description)}">
<meta property="og:image" content="${esc(img)}">
<meta name="twitter:card" content="summary_large_image">
<link rel="icon" type="image/png" sizes="32x32" href="/assets/icon-32.png">
<link rel="apple-touch-icon" href="/assets/icon-180.png">
<link rel="stylesheet" href="/assets/static.css?v=2">
${ld.map(jsonLd).join("\n")}
</head>
<body>
<nav class="screen-nav" aria-label="ניווט בין מסכים">
  <button type="button" class="sn-btn" onclick="history.back()" title="חזרה למסך הקודם"><span class="sn-arrow" aria-hidden="true">→</span> הקודם</button>
  <a class="sn-btn sn-home" href="/" title="לדף הבית"><span aria-hidden="true">🏠</span> דף הבית</a>
  <button type="button" class="sn-btn" onclick="history.forward()" title="קדימה למסך הבא">הבא <span class="sn-arrow" aria-hidden="true">←</span></button>
</nav>
<header class="top">
  <a class="home" href="/"><img src="/assets/title.webp?v=3" alt="${SITE_NAME}" width="900" height="224"></a>
  <p class="sub">שיעורי קבלה של ${RABBI}</p>
</header>
<main>
${body}
</main>
<footer>
  <p><a href="/">${SITE_NAME}</a> · <a href="/lessons/">כל הסדרות והשיעורים</a> · <a href="/about/">אודות ${RABBI}</a></p>
  <p class="about">${SITE_NAME} (Ginzei Haim) הוא אתר השיעורים של ${RABBI} (${RABBI_EN}): שיעורים בקבלה, בכוונות התפילה, בסעודה ובמועדי השנה, בווידאו, בהקלטות שמע ובדפי מקורות.</p>
</footer>
<script data-goatcounter="https://ginzei-haim.goatcounter.com/count" async src="https://gc.zgo.at/count.js"></script>
</body>
</html>
`;
}

function breadcrumbs(items){
  const html = `<nav class="crumbs" aria-label="פירורי לחם">${items.map((it, i) =>
    i < items.length - 1 ? `<a href="${esc(it.path)}">${esc(it.name)}</a>` : `<span aria-current="page">${esc(it.name)}</span>`
  ).join(' <span aria-hidden="true">›</span> ')}</nav>`;
  const ld = {
    "@context": "https://schema.org",
    "@type": "BreadcrumbList",
    itemListElement: items.map((it, i) => ({ "@type": "ListItem", position: i + 1, name: it.name, item: SITE + it.path })),
  };
  return { html, ld };
}

function lessonItem(id){
  const v = VIDEOS[id];
  const m = mediaOf(id);
  const tags = [v.published && hebDate(v.published), v.duration, v.audioOnly ? "שמע" : "וידאו", m && m.a && !v.audioOnly ? "mp3" : "", m && m.p.length ? "PDF" : ""].filter(Boolean);
  return `<li><a href="${lessonPath(id)}">${esc(v.title)}</a> <span class="meta">${esc(tags.join(" · "))}</span></li>`;
}

// ---- דף שיעור ----
function buildLesson(id){
  const v = VIDEOS[id];
  const series = seriesOf[id] || [];
  const main = series[0];
  const m = mediaOf(id);
  const url = SITE + lessonPath(id);
  const seriesNames = series.map(p => p.name).join(", ");
  const desc = truncate(`${v.title}. שיעור של ${RABBI}${main ? " מתוך הסדרה " + main.name : ""}${v.published ? ", " + hebDate(v.published) : ""}.${v.audioOnly ? " הקלטת שמע" : " וידאו"}${m && m.a && !v.audioOnly ? ", הקלטת mp3" : ""}${m && m.p.length ? " ודף מקורות PDF" : ""}.`, 300);
  const crumbs = breadcrumbs([
    { name: SITE_NAME, path: "/" },
    { name: "כל הסדרות", path: "/lessons/" },
    ...(main ? [{ name: main.name, path: seriesPath(main) }] : []),
    { name: v.title, path: lessonPath(id) },
  ]);
  const thumb = v.audioOnly ? null : `https://i.ytimg.com/vi/${id}/hqdefault.jpg`;
  const common = {
    "@context": "https://schema.org",
    name: v.title,
    description: desc,
    inLanguage: "he",
    url,
    author: { "@id": SITE + "/#rabbi" },
    ...(v.uploaded || v.published ? { uploadDate: v.uploaded || v.published } : {}),
    ...(isoDuration(v.duration) ? { duration: isoDuration(v.duration) } : {}),
    isPartOf: main ? { "@type": "CreativeWorkSeries", name: main.name, url: SITE + seriesPath(main) } : undefined,
  };
  const ld = [crumbs.ld, { ...PERSON, "@context": "https://schema.org" }];
  if(v.audioOnly){
    if(m && m.a) ld.push({ ...common, "@type": "AudioObject", contentUrl: mediaUrl(m.a), encodingFormat: "audio/mpeg" });
  } else {
    ld.push({ ...common, "@type": "VideoObject", thumbnailUrl: [thumb], embedUrl: `https://www.youtube.com/embed/${id}`, contentUrl: `https://www.youtube.com/watch?v=${id}` });
  }

  const player = v.audioOnly
    ? `<div class="audio-only">🎧 הקלטת שמע</div>`
    : `<div class="video"><iframe src="https://www.youtube-nocookie.com/embed/${id}" title="${esc(v.title)}" loading="lazy" allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture" allowfullscreen></iframe></div>`;
  const files = m ? `<div class="files">
${m.a ? `<audio controls preload="none" src="${esc(mediaUrl(m.a))}"></audio>
<a class="btn" href="${esc(mediaUrl(m.a))}" download>⬇ הורדת mp3</a>` : ""}
${m.p.map((p, i) => `<a class="btn" href="${esc(mediaUrl(p))}" target="_blank" rel="noopener">📄 דף מקורות${m.p.length > 1 ? " " + (i + 1) : ""} (PDF)</a>`).join("\n")}
</div>` : "";

  let nav = "";
  if(main){
    const i = main.ids.indexOf(id);
    const prev = main.ids[i - 1], next = main.ids[i + 1];
    nav = `<nav class="prevnext" aria-label="שיעורים בסדרה">
${prev ? `<a href="${lessonPath(prev)}">→ ${esc(truncate(VIDEOS[prev].title, 70))}</a>` : "<span></span>"}
${next ? `<a href="${lessonPath(next)}">${esc(truncate(VIDEOS[next].title, 70))} ←</a>` : "<span></span>"}
</nav>`;
  }

  const body = `${crumbs.html}
<article>
<h1>${esc(v.title)}</h1>
<p class="meta">${RABBI}${v.published ? " · " + hebDate(v.published) : ""}${v.duration ? " · " + esc(prettyDuration(v.duration)) : ""}</p>
${player}
${files}
<p><a class="btn primary" href="/?v=${encodeURIComponent(id)}">פתיחה בנגן של האתר (מועדפים, המשך אוטומטי לשיעור הבא)</a></p>
${series.length ? `<p>הסדרה: ${series.map(p => `<a href="${seriesPath(p)}">${esc(p.name)}</a>`).join(" · ")}</p>` : ""}
</article>
${nav}`;
  return page({
    title: `${truncate(v.title, 70)} | ${RABBI} | ${SITE_NAME}`,
    description: desc,
    canonical: url,
    ogType: v.audioOnly ? "music.song" : "video.other",
    image: thumb,
    ld,
    body,
  });
}

// ---- דף סדרה ----
function buildSeries(p){
  const url = SITE + seriesPath(p);
  const place = p.place ? placeLabel(p.place) : "";
  const cat = CAT_LABEL[p.category] || "";
  const dates = p.ids.map(id => VIDEOS[id].published).filter(Boolean).sort();
  const desc = truncate(`${p.name}: ${p.ids.length} שיעורים של ${RABBI}${place && place !== "כללי" ? " בקבוצת " + place : ""}${cat ? ", בנושא " + cat : ""}. וידאו, הקלטות ודפי מקורות.`, 300);
  const crumbs = breadcrumbs([
    { name: SITE_NAME, path: "/" },
    { name: "כל הסדרות", path: "/lessons/" },
    { name: p.name, path: seriesPath(p) },
  ]);
  const ld = [crumbs.ld, {
    "@context": "https://schema.org",
    "@type": "CollectionPage",
    name: p.name,
    description: desc,
    url,
    inLanguage: "he",
    author: { "@id": SITE + "/#rabbi" },
    mainEntity: {
      "@type": "ItemList",
      numberOfItems: p.ids.length,
      itemListElement: p.ids.slice(0, 200).map((id, i) => ({ "@type": "ListItem", position: i + 1, url: SITE + lessonPath(id), name: VIDEOS[id].title })),
    },
  }];
  const body = `${crumbs.html}
<h1>${esc(p.name)}</h1>
<p class="meta">${p.ids.length} שיעורים${place ? " · קבוצה: " + esc(place) : ""}${cat ? " · נושא: " + esc(cat) : ""}${dates.length ? " · " + hebDate(dates[0]) + (dates.length > 1 ? " עד " + hebDate(dates[dates.length - 1]) : "") : ""}</p>
${p.description ? `<p>${esc(p.description)}</p>` : ""}
<p><a class="btn primary" href="/?playlist=${encodeURIComponent(p.id)}">פתיחת הסדרה בנגן של האתר</a></p>
<ol class="lessons">
${p.ids.map(lessonItem).join("\n")}
</ol>`;
  return page({ title: `${p.name} | שיעורי ${RABBI} | ${SITE_NAME}`, description: desc, canonical: url, ld, body });
}

// ---- רשימת כל הסדרות ----
function buildIndex(){
  const url = SITE + "/lessons/";
  const byCat = {};
  for(const p of PLAYLISTS) (byCat[p.category] ||= []).push(p);
  const order = [...(DATA.categories || []).map(c => c.key), ...Object.keys(byCat).filter(k => !CAT_LABEL[k])];
  const sections = order.filter(k => byCat[k]).map(k => `<section>
<h2>${esc(CAT_LABEL[k] || "שונות")}</h2>
<ul class="series">
${byCat[k].map(p => `<li><a href="${seriesPath(p)}">${esc(p.name)}</a> <span class="meta">${p.ids.length} שיעורים</span></li>`).join("\n")}
</ul>
</section>`).join("\n");
  const recent = (DATA.uploads || []).filter(id => VIDEOS[id]).slice(0, 30);
  const total = Object.keys(VIDEOS).length;
  const desc = `כל ${PLAYLISTS.length} הסדרות ו-${total} השיעורים של ${RABBI} (${RABBI_EN}) באתר ${SITE_NAME}: קבלה, כוונות התפילה, הסעודה, חגים ומועדים.`;
  const crumbs = breadcrumbs([{ name: SITE_NAME, path: "/" }, { name: "כל הסדרות", path: "/lessons/" }]);
  const body = `${crumbs.html}
<h1>כל הסדרות והשיעורים של ${RABBI}</h1>
<p>${SITE_NAME} מרכז את שיעורי הקבלה של ${RABBI} (${RABBI_EN}) בקבוצות בבית וגן, בהר חומה, ביד בנימין, במבוא חורון ובישיבה. יש כאן ${total} שיעורים ב-${PLAYLISTS.length} סדרות, בווידאו, בהקלטות שמע ובדפי מקורות להורדה. שיעורים חדשים מתווספים אוטומטית.</p>
<p><a class="btn primary" href="/">לנגן ולחיפוש באתר</a></p>
${sections}
${recent.length ? `<section><h2>שיעורים אחרונים</h2><ul class="lessons">${recent.map(lessonItem).join("\n")}</ul></section>` : ""}`;
  return page({ title: `כל הסדרות והשיעורים | ${RABBI} | ${SITE_NAME}`, description: desc, canonical: url, ld: [crumbs.ld], body });
}

// ---- אודות: דף שעיקר נושאו הרב והאתר, כדי שחיפוש בשם הרב או בשם האתר בעברית יגיע לכאן ----
function buildAbout(){
  const url = SITE + "/about/";
  const total = Object.keys(VIDEOS).length;
  const crumbs = breadcrumbs([{ name: SITE_NAME, path: "/" }, { name: "אודות", path: "/about/" }]);
  const cats = (DATA.categories || []).map(c => CAT_LABEL[c.key]).filter(Boolean);
  const desc = `${SITE_NAME} הוא אתר שיעורי הקבלה של ${RABBI} (${RABBI_EN}): ${total} שיעורים בווידאו, בהקלטות שמע ובדפי מקורות, מסודרים לפי נושאים וקבוצות.`;
  const ld = [{
    "@context": "https://schema.org",
    "@type": "ProfilePage",
    "@id": url,
    url,
    name: `${RABBI} | ${SITE_NAME}`,
    inLanguage: "he",
    isPartOf: { "@id": SITE + "/#website" },
    mainEntity: { ...PERSON, url: SITE + "/" },
  }, crumbs.ld];
  const body = `${crumbs.html}
<h1>${RABBI} ו${SITE_NAME}</h1>
<p><strong>${SITE_NAME}</strong> (Ginzei Haim) הוא האתר שמרכז את השיעורים של <strong>${RABBI}</strong> (${RABBI_EN}). באתר ${total} שיעורים ב-${PLAYLISTS.length} סדרות: שיעורי קבלה, כוונות התפילה, הסעודה, חגים ומועדי השנה.</p>
<p>${RABBI} מוסר שיעורים בקבוצות בבית וגן, בהר חומה, ביד בנימין, במבוא חורון ובישיבה. השיעורים זמינים באתר ${SITE_NAME} בווידאו או בהקלטת שמע, ולרבים מהם יש גם קובץ mp3 ודף מקורות (PDF) להורדה. שיעורים חדשים של ${RABBI} מתווספים לאתר אוטומטית.</p>
${cats.length ? `<h2>נושאי השיעורים</h2><ul>${cats.map(c => `<li>${esc(c)}</li>`).join("")}</ul>` : ""}
<p><a class="btn primary" href="/">לכל שיעורי ${RABBI} באתר ${SITE_NAME}</a> <a class="btn" href="/lessons/">רשימת כל הסדרות</a></p>`;
  return page({ title: `${RABBI} | שיעורי קבלה | ${SITE_NAME}`, description: desc, canonical: url, ogType: "profile", ld, body });
}

function write(rel, html){
  const p = path.join(ROOT, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, html);
}

// ניקוי דפים ישנים (שיעור שנמחק לא יישאר באתר)
for(const d of ["lesson", "series", "lessons", "about"]) fs.rmSync(path.join(ROOT, d), { recursive: true, force: true });

write("lessons/index.html", buildIndex());
write("about/index.html", buildAbout());
for(const p of PLAYLISTS) write(`series/${p.id}/index.html`, buildSeries(p));
const lessonIds = Object.keys(VIDEOS);
for(const id of lessonIds) write(`lesson/${id}/index.html`, buildLesson(id));

const today = new Date().toISOString().slice(0, 10);
const latestOf = (ids) => ids.map(id => VIDEOS[id].published).filter(Boolean).sort().pop() || today;
const urls = [
  { loc: SITE + "/", lastmod: latestOf(lessonIds), priority: "1.0" },
  { loc: SITE + "/lessons/", lastmod: latestOf(lessonIds), priority: "0.9" },
  { loc: SITE + "/about/", lastmod: today, priority: "0.9" },
  ...PLAYLISTS.map(p => ({ loc: SITE + seriesPath(p), lastmod: latestOf(p.ids), priority: "0.8" })),
  ...lessonIds.map(id => ({ loc: SITE + lessonPath(id), lastmod: (VIDEOS[id].published || today).slice(0, 10), priority: "0.6" })),
];
write("sitemap.xml", `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${urls.map(u => `  <url><loc>${esc(u.loc)}</loc><lastmod>${u.lastmod}</lastmod><priority>${u.priority}</priority></url>`).join("\n")}
</urlset>
`);
console.log(`נבנו ${PLAYLISTS.length} דפי סדרות, ${lessonIds.length} דפי שיעורים, מפת אתר עם ${urls.length} כתובות`);
