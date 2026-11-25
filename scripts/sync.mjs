#!/usr/bin/env node
// סנכרון השיעורים מערוצי היוטיוב (config.channels) אל data/lessons.js
// שימוש: YT_API_KEY=... node scripts/sync.mjs
// אין תלויות חיצוניות (Node 18 ומעלה).

import { readFile, writeFile, appendFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CONFIG_PATH = path.join(ROOT, "config.json");
const OUT_PATH = path.join(ROOT, "data", "lessons.js");
const SEEN_PATH = path.join(ROOT, "data", "seen.json");
// סרטונים שכבר באתר אבל עוד לא סופיים (פרמיירה מתוכננת, שידור חי, בעיבוד), עם "חתימה" של מצבם.
// הבדיקה המהירה מסנכרנת מחדש רק כשהחתימה משתנה (למשל הפרמיירה הסתיימה ויש משך).
const PENDING_PATH = path.join(ROOT, "data", "pending.json");
// מועד הסנכרון המלא האחרון. מספרי הצפיות מתעדכנים רק בסנכרון מלא, ולכן הבדיקה המהירה מריצה סנכרון מלא
// גם כשלא הועלה שיעור חדש: בשעות REFRESH_HOURS_UTC (בנוסף לסנכרון המלא של 03:00), אם עברו לפחות 5 שעות מהסנכרון המלא האחרון.
// השעות הקבועות מגבילות את הניסיונות החוזרים אם סנכרון נכשל (כ-130 יחידות מכסה לכל סנכרון מלא, מתוך 10,000 ביום).
const LAST_FULL_PATH = path.join(ROOT, "data", "last-full.json");
const REFRESH_HOURS_UTC = [9, 15, 21];
const FULL_MIN_GAP_HOURS = 5;
const QUICK = process.env.QUICK === "1";
const API = "https://www.googleapis.com/youtube/v3/";

const KEY = process.env.YT_API_KEY;
if (!KEY) {
  console.error("חסר YT_API_KEY (מפתח YouTube Data API)");
  process.exit(1);
}

const config = JSON.parse(await readFile(CONFIG_PATH, "utf8"));
let quota = 0;
const dateOf = v => v.date || v.published || "";

// תאריך עברי בטקסט ("ז׳ כסלו התשפ״ז", "כ״ג תמוז התשפ״ו") -> תאריך לועזי (YYYY-MM-DD).
// מחפשים את היום הלועזי שמתאים לתאריך העברי בטווח שנה אחורה מתאריך הפרסום. בלי שנה בטקסט, רק עד 90 יום אחורה.
const GEM = { א:1,ב:2,ג:3,ד:4,ה:5,ו:6,ז:7,ח:8,ט:9,י:10,כ:20,ך:20,ל:30,מ:40,ם:40,נ:50,ן:50,ס:60,ע:70,פ:80,ף:80,צ:90,ץ:90,ק:100,ר:200,ש:300,ת:400 };
const gem = t => [...t.replace(/[^א-ת]/g, "")].reduce((a, c) => a + (GEM[c] || 0), 0);
const monthSig = t => t.replace(/[^א-ת]/g, "").replace(/ו/g, "").replace(/^מר/, "");
const hebFmt = new Intl.DateTimeFormat("he-u-ca-hebrew", { day: "numeric", month: "long", year: "numeric" });
function parseHebrewDate(text, published) {
  const m = (text || "").match(/(?:^|[\s.,])([א-ל][׳'"״]?[א-ט]?[׳'"״]?)\s+(?:ב)?([א-ת]+(?:\s*[׳'][א-ב]?|\s+[אב][׳'])?)\s+ה?(ת[א-ת]{1,3}[׳'"״]?[א-ת]?)/);
  if (!m || !published) return "";
  const day = gem(m[1]), mon = monthSig(m[2]), yr = gem(m[3]) + (gem(m[3]) < 1000 ? 5000 : 0);
  if (day < 1 || day > 30) return "";
  const end = Date.parse(published);
  for (let i = 0; i <= 400; i++) {
    const t = new Date(end - i * 864e5), parts = Object.fromEntries(hebFmt.formatToParts(t).map(x => [x.type, x.value]));
    if (Number(parts.day) !== day || monthSig(parts.month) !== mon || Number(parts.year) !== yr) continue;
    return t.toISOString().slice(0, 10);
  }
  return "";
}

// תאריך שיעור מתוך טקסט: JH-26-11-17 / 26-11-17 / 2026-11-17 (שנה-חודש-יום), או 17.11.26 / 17/11/2026 (יום.חודש.שנה).
// נדחה תאריך מחוץ לטווח או אחרי תאריך הפרסום (שיעור לא יכול להינתן אחרי שהועלה).
function parseLessonDate(text, published) {
  const cands = [];
  for (const m of (text || "").matchAll(/(?<!\d)((?:20)?\d\d)-(\d\d)-(\d\d)(?!\d)/g)) cands.push([m[1], m[2], m[3]]);
  for (const m of (text || "").matchAll(/(?<!\d)(\d{1,2})[./](\d{1,2})[./]((?:20)?\d\d)(?!\d)/g)) cands.push([m[3], m[2], m[1]]);
  for (let [y, mo, d] of cands) {
    if (y.length === 2) y = "20" + y;
    const iso = `${y}-${mo.padStart(2, "0")}-${d.padStart(2, "0")}`;
    const t = Date.parse(iso);
    if (Number.isNaN(t) || new Date(t).toISOString().slice(0, 10) !== iso) continue;
    if (iso < "2015-01-01" || (published && iso > published)) continue;
    return iso;
  }
  return "";
}

async function api(endpoint, params) {
  const url = new URL(endpoint, API);
  for (const [k, v] of Object.entries({ ...params, key: KEY })) url.searchParams.set(k, v);
  for (let attempt = 1; ; attempt++) {
    const res = await fetch(url);
    quota++;
    if (res.ok) return res.json();
    const body = await res.text();
    if (res.status === 404 && endpoint === "playlistItems") return { items: [] };
    if (attempt < 3 && res.status >= 500) {
      await new Promise(r => setTimeout(r, 2000 * attempt));
      continue;
    }
    throw new Error(`${endpoint} ${res.status}: ${body.slice(0, 500)}`);
  }
}

async function paged(endpoint, params) {
  const items = [];
  let pageToken;
  do {
    const data = await api(endpoint, { ...params, maxResults: 50, ...(pageToken ? { pageToken } : {}) });
    items.push(...(data.items || []));
    pageToken = data.nextPageToken;
  } while (pageToken);
  return items;
}

function isoDuration(iso) {
  const m = /^P(?:(\d+)D)?T?(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/.exec(iso || "");
  if (!m) return { text: "", seconds: 0 };
  const [d, h, mi, s] = m.slice(1).map(x => parseInt(x || "0", 10));
  const hours = d * 24 + h;
  const seconds = hours * 3600 + mi * 60 + s;
  const pad = n => String(n).padStart(2, "0");
  const text = hours ? `${hours}:${pad(mi)}:${pad(s)}` : `${mi}:${pad(s)}`;
  return { text, seconds };
}

// מצב הסרטון ביוטיוב. כשהוא משתנה (פרמיירה התחילה/נגמרה, העיבוד הסתיים, שם הוחלף) מסנכרנים מחדש.
function signature(v) {
  if (!v) return "gone";
  return [v.status && v.status.privacyStatus, v.status && v.status.uploadStatus,
    v.snippet.liveBroadcastContent, v.contentDetails && v.contentDetails.duration, v.snippet.title].join("|");
}

// ---- 1. הערוצים ----
// config.channels: רשימת ערוצים, לכל אחד handle או id, ו-filter אופציונלי (בלי filter = כל הסרטונים בערוץ הם שיעורי הרב).
// תאימות לאחור: אם אין רשימה, משתמשים בשדות הישנים channelHandle/channelId/filter.
const channelDefs = config.channels && config.channels.length
  ? config.channels
  : [{ handle: config.channelHandle, id: config.channelId, filter: config.filter }];
const channels = [];
for (const def of channelDefs) {
  const params = def.id ? { id: def.id } : { forHandle: def.handle };
  const ch = await api("channels", { part: "snippet,contentDetails", ...params });
  if (!ch.items || !ch.items.length) throw new Error("הערוץ לא נמצא: " + JSON.stringify(params));
  const c = ch.items[0];
  channels.push({ def, channel: c, uploadsId: c.contentDetails.relatedPlaylists.uploads });
  console.log("ערוץ:", c.snippet.title, c.id);
}

async function setOutput(k, v) {
  if (process.env.GITHUB_OUTPUT) await appendFile(process.env.GITHUB_OUTPUT, `${k}=${v}\n`);
}

// ---- בדיקה מהירה: האם הועלה סרטון חדש מאז הסנכרון הקודם? (2 יחידות מכסה) ----
if (QUICK) {
  let seen = null;
  try { seen = new Set(JSON.parse(await readFile(SEEN_PATH, "utf8"))); } catch {}
  if (seen) {
    // 50 הסרטונים האחרונים של כל ערוץ (יחידת מכסה אחת לכל ערוץ)
    const recent = [];
    for (const c of channels) {
      const first = await api("playlistItems", { part: "contentDetails", playlistId: c.uploadsId, maxResults: 50 });
      recent.push(...(first.items || []).map(i => i.contentDetails && i.contentDetails.videoId));
    }
    let pendingPrev = {};
    try { pendingPrev = JSON.parse(await readFile(PENDING_PATH, "utf8")); } catch {}
    const unseen = [...new Set(recent)].filter(id => id && !seen.has(id));
    // סרטון שכבר באתר כ"לא סופי": בודקים אם מצבו השתנה (יחידת מכסה אחת לכל 50)
    const waiting = unseen.filter(id => id in pendingPrev);
    const fresh = unseen.filter(id => !(id in pendingPrev));
    for (let i = 0; i < waiting.length; i += 50) {
      const batch = waiting.slice(i, i + 50);
      const data = await api("videos", { part: "snippet,contentDetails,status", id: batch.join(",") });
      const byId = Object.fromEntries((data.items || []).map(v => [v.id, v]));
      for (const id of batch) if (signature(byId[id]) !== pendingPrev[id]) fresh.push(id);
    }
    let lastFull = 0;
    try { lastFull = Date.parse(JSON.parse(await readFile(LAST_FULL_PATH, "utf8")).at) || 0; } catch {}
    const stale = REFRESH_HOURS_UTC.includes(new Date().getUTCHours()) && Date.now() - lastFull > FULL_MIN_GAP_HOURS * 3600 * 1000;
    if (!fresh.length && stale) console.log("רענון תקופתי: סנכרון מלא כדי לעדכן את מספרי הצפיות.");
    if (!fresh.length && !stale) {
      console.log("אין סרטונים חדשים בערוץ, מדלג.");
      await setOutput("skip", "true");
      process.exit(0);
    }
    console.log("נמצאו סרטונים חדשים:", fresh.join(", "));
  }
}

// ---- 2. הפלייליסטים ----
const exclude = new Set(config.excludePlaylistIds || []);
const rawPlaylists = [];
for (const c of channels) {
  c.playlists = (await paged("playlists", { part: "snippet,contentDetails", channelId: c.channel.id }))
    .filter(p => !exclude.has(p.id) && !rawPlaylists.some(q => q.id === p.id));
  rawPlaylists.push(...c.playlists);
}
console.log("פלייליסטים:", rawPlaylists.length);

async function playlistVideoIds(playlistId) {
  const items = await paged("playlistItems", { part: "contentDetails", playlistId });
  return items.map(i => i.contentDetails && i.contentDetails.videoId).filter(Boolean);
}

const uploadIds = [];
const playlistIds = {};
for (const c of channels) {
  c.uploadIds = await playlistVideoIds(c.uploadsId);
  uploadIds.push(...c.uploadIds);
  for (const p of c.playlists) playlistIds[p.id] = await playlistVideoIds(p.id);
}

// ---- 3. פרטי הסרטונים ----
const allIds = [...new Set([...uploadIds, ...Object.values(playlistIds).flat()])];
const videos = {};
// סרטונים שעדיין לא סופיים. לא מסמנים אותם כ"נראו", כדי שהבדיקה המהירה תבדוק אותם שוב:
// - פרטיים/לא נמצאו: לא מוצגים באתר בכלל (אין קישור שעובד).
// - פרמיירה מתוכננת, שידור חי, או בעיבוד: מוצגים באתר מיד, ומתעדכנים (משך, שם) כשהם מסתיימים.
const pending = new Set(allIds);
const pendingSig = {};
for (let i = 0; i < allIds.length; i += 50) {
  const batch = allIds.slice(i, i + 50);
  const data = await api("videos", { part: "snippet,contentDetails,status,statistics,liveStreamingDetails,recordingDetails", id: batch.join(",") });
  for (const v of data.items || []) {
    const privacy = v.status && v.status.privacyStatus;
    if (privacy !== "public" && privacy !== "unlisted") continue;
    const lbc = v.snippet.liveBroadcastContent;
    const live = lbc === "upcoming" ? "upcoming" : lbc === "live" ? "live" : "";
    const dur = isoDuration(v.contentDetails.duration);
    const processing = !live && (!dur.seconds || (v.status.uploadStatus && v.status.uploadStatus !== "processed"));
    if (live || processing) pendingSig[v.id] = signature(v);
    else pending.delete(v.id);
    // סינון לפי אורך מינימלי רק כשהאורך כבר ידוע
    if (!live && !processing && config.minDurationSeconds && dur.seconds < config.minDurationSeconds) continue;
    const lsd = v.liveStreamingDetails || {};
    const start = live === "upcoming" ? lsd.scheduledStartTime : live === "live" ? (lsd.actualStartTime || lsd.scheduledStartTime) : "";
    videos[v.id] = {
      title: v.snippet.title.trim(),
      description: v.snippet.description || "",
      duration: live || processing ? "" : dur.text,
      published: (start || v.snippet.publishedAt || "").slice(0, 10),
      recorded: ((v.recordingDetails && v.recordingDetails.recordingDate) || "").slice(0, 10),
      views: Number((v.statistics && v.statistics.viewCount) || 0),
      ...(live ? { live } : {}),
      ...(live === "upcoming" && start ? { startsAt: start } : {}),
    };
  }
}
// ---- סינון: רק שיעורי הרב ----
// סרטון שמופיע בערוץ בלי סינון (הערוץ האישי של הרב) נשאר תמיד. סרטון מערוץ עם סינון נשאר רק אם עבר את הסינון של אותו ערוץ.
const idsOf = c => [...c.uploadIds, ...c.playlists.flatMap(p => playlistIds[p.id])];
const keepAlways = new Set();
const filtered = [];
for (const c of channels) {
  const f = c.def.filter || {};
  const kws = (f.keywords || []).filter(Boolean);
  const keepIds = new Set((f.playlistIds || []).flatMap(id => playlistIds[id] || []));
  if (kws.length || keepIds.size) filtered.push({ ids: new Set(idsOf(c)), kws, keepIds });
  else for (const id of idsOf(c)) keepAlways.add(id);
}
if (filtered.length) {
  for (const id of Object.keys(videos)) {
    if (keepAlways.has(id)) continue;
    const text = videos[id].title + " " + videos[id].description;
    const ok = filtered.some(g => g.ids.has(id) && (g.keepIds.has(id) || g.kws.some(k => text.includes(k))));
    if (!ok) delete videos[id];
  }
  console.log("אחרי סינון לפי הרב:", Object.keys(videos).length);
}
// ---- תאריך השיעור ----
// התאריך שבו ניתן השיעור, לא היום שהועלה ליוטיוב. מחפשים אותו בכותרת, בתיאור (למשל שם הקובץ JH-26-11-17), ואז בתאריך ההקלטה
// שמוגדר בסרטון. אם אין כלום, נשאר תאריך הפרסום. הוא משמש למיון ולהתאמת קבצי שמע ו-PDF (שהשם שלהם מתחיל בתאריך השיעור).
// נשמר ב-videos[id].date רק כשהוא שונה מתאריך הפרסום.
const dateStats = { title: 0, description: 0, recorded: 0, none: 0 };
for (const [id, v] of Object.entries(videos)) {
  // בתיאור לא מחפשים תאריך לועזי: שם קובץ ה-PDF שמופיע שם הוא תאריך דף המקורות, לא תאריך השיעור. בתיאור יש תאריך עברי ("ז׳ כסלו התשפ״ז").
  let d = parseLessonDate(v.title, v.published) || parseHebrewDate(v.title, v.published), src = "title";
  if (!d) { d = parseHebrewDate(v.description, v.published); src = "description"; }
  if (!d && v.recorded && v.recorded >= "2015" && v.recorded <= v.published) { d = v.recorded; src = "recorded"; }
  if (d) dateStats[src]++; else dateStats.none++;
  if (d && d !== v.published) v.date = d;
  delete v.recorded;
  delete v.description;
}
console.log("מקור תאריך השיעור:", JSON.stringify(dateStats));
const known = id => Object.prototype.hasOwnProperty.call(videos, id);
console.log("סרטונים זמינים:", Object.keys(videos).length);

// ---- 4. שיוך לקטגוריות ----
const categories = (config.categories || []).map(c => ({ key: c.key, label: c.label, color: c.color }));
if (!categories.some(c => c.key === "other")) {
  categories.push({ key: "other", label: "נושאים נוספים", color: "#64748b" });
}
function categoryFor(p) {
  for (const c of config.categories || []) {
    if ((c.playlistIds || []).includes(p.id)) return c.key;
    if ((c.keywords || []).some(k => k && p.snippet.title.includes(k))) return c.key;
  }
  return "other";
}

const playlists = rawPlaylists
  .map(p => ({
    id: p.id,
    name: p.snippet.title.trim(),
    description: (p.snippet.description || "").trim().slice(0, 400),
    category: categoryFor(p),
    videoIds: [...new Set(playlistIds[p.id])].filter(known),
  }))
  .filter(p => p.videoIds.length > 0);

// סרטונים שלא נמצאים באף פלייליסט
const inPlaylist = new Set(playlists.flatMap(p => p.videoIds));
const uploads = [...new Set(uploadIds)].filter(known)
  .sort((a, b) => dateOf(videos[b]).localeCompare(dateOf(videos[a])));
const loose = uploads.filter(id => !inPlaylist.has(id));
if (loose.length) {
  playlists.push({
    id: "more",
    name: "שיעורים נוספים",
    description: "שיעורים שעדיין לא שויכו לפלייליסט",
    category: "other",
    videoIds: loose,
  });
}
const usedCats = new Set(playlists.map(p => p.category));
const finalCategories = categories.filter(c => usedCats.has(c.key));

// ---- 5. בדיקת שפיות: לא למחוק את האתר בגלל תקלה ----
let previousCount = 0;
try {
  const prev = await readFile(OUT_PATH, "utf8");
  const m = prev.match(/window\.LESSONS_DATA = (\{[\s\S]*\});/);
  if (m) previousCount = Object.keys(JSON.parse(m[1]).videos || {}).length;
} catch {}
const count = Object.keys(videos).length;
if (previousCount > 20 && count < previousCount * 0.5) {
  throw new Error(`נמצאו רק ${count} סרטונים לעומת ${previousCount} בסנכרון הקודם. עוצר כדי לא למחוק שיעורים.`);
}

// ---- הסרת קידומת קבועה מהשמות המוצגים ----
const prefix = config.stripPrefix || "";
const clean = t => (prefix && t.startsWith(prefix) ? t.slice(prefix.length) : t).trim() || t;
for (const v of Object.values(videos)) v.title = clean(v.title);
for (const p of playlists) p.name = clean(p.name);
// ---- כפילויות בין ערוצים ----
// שיעור שהרב העלה מחדש לערוץ החדש (אותו שם בדיוק, משך דומה) מוצג פעם אחת, מהערוץ המאוחר ברשימת config.channels.
// השיעור שנשאר יורש את תאריך השיעור המקורי, את מספר הצפיות הגבוה, ואת קבצי השמע וה-PDF של הסרטון הישן (out.replaces).
const chOf = {};
channels.forEach((c, i) => { for (const id of idsOf(c)) chOf[id] = i; });
const norm = t => t.replace(/\s+/g, " ").trim();
const byTitle = {};
for (const id of Object.keys(videos)) (byTitle[norm(videos[id].title)] ||= []).push(id);
const replaces = {};
const droppedBy = {};
const secs = d => d.split(":").reduce((a, x) => a * 60 + Number(x), 0);
for (const ids of Object.values(byTitle)) {
  if (ids.length < 2) continue;
  const newest = Math.max(...ids.map(id => chOf[id] ?? 0));
  const keepers = ids.filter(id => (chOf[id] ?? 0) === newest);
  const olds = ids.filter(id => (chOf[id] ?? 0) < newest);
  if (keepers.length !== 1 || !olds.length) continue;
  const keep = keepers[0];
  // שיעור שעדיין בשידור חי או בעיבוד (בלי משך) לא מוחלף בשיעור ישן באותה כותרת ולא מחליף אותו (למשל "חנוכה - שיעור 02" של שנה שעברה):
  // מחכים עד שיש משך לשניהם. בלי זה השיעור החי נבלע בשיעור הישן ולא מופיע כשיעור חדש עד סוף השידור.
  const match = olds.filter(o => videos[o].duration && videos[keep].duration && Math.abs(secs(videos[o].duration) - secs(videos[keep].duration)) <= 10);
  if (!match.length) continue;
  const old = [...match].sort((a, b) => dateOf(videos[a]).localeCompare(dateOf(videos[b])))[0];
  for (const o of match) droppedBy[o] = keep;
  replaces[keep] = old;
  if (videos[old].published) videos[keep].published = videos[old].published;
  if (videos[old].date && !videos[keep].date) videos[keep].date = videos[old].date;
  videos[keep].views = Math.max(...match.map(o => videos[o].views || 0), videos[keep].views || 0);
}
// החלפה ידנית: config.replacements = { "מזהה סרטון ישן": "מזהה סרטון חדש" }. עובדת גם כשהכותרות שונות.
// משתמשים בזה כשהשיעור הועלה מחדש לערוץ החדש בלי אותה כותרת בדיוק. שני הסרטונים צריכים להיות באתר (ציבוריים ומעובדים).
for (const [o, n] of Object.entries(config.replacements || {})) {
  if (o.startsWith("_") || !videos[o] || !videos[n] || o === n) continue;
  droppedBy[o] = n;
  replaces[n] = o;
  if (videos[o].published) videos[n].published = videos[o].published;
  if (videos[o].date && !videos[n].date) videos[n].date = videos[o].date;
  videos[n].views = Math.max(videos[o].views || 0, videos[n].views || 0);
}
if (Object.keys(droppedBy).length) {
  console.log("כפילויות בין ערוצים שהוסתרו:", Object.keys(droppedBy).length);
  for (const o of Object.keys(droppedBy)) delete videos[o];
  const remap = ids => [...new Set(ids.map(id => droppedBy[id] || id))];
  for (const p of playlists) p.videoIds = remap(p.videoIds);
  const upl = remap(uploads).filter(id => videos[id]);
  uploads.length = 0;
  uploads.push(...upl);
  uploads.sort((a, b) => dateOf(videos[b]).localeCompare(dateOf(videos[a])));
}
for (const id of Object.keys(videos)) if ((chOf[id] ?? 0) > 0) videos[id].ch = chOf[id];
// פלייליסט באותו שם בכמה ערוצים (למשל סדרה שהתחילה בערוץ הישן וממשיכה בערוץ האישי) מוצג כסדרה אחת, עם המזהה של הראשון
for (let i = playlists.length - 1; i >= 0; i--) {
  const p = playlists[i];
  const first = playlists.findIndex(q => q.id !== "more" && q.name === p.name);
  if (p.id === "more" || first === i) continue;
  playlists[first].videoIds = [...new Set([...playlists[first].videoIds, ...p.videoIds])];
  playlists.splice(i, 1);
}

// ---- מקום ונושא לכל פלייליסט, לפי רשימת המקומות ב-config ----
const places = config.places || [];
for (const p of playlists) {
  const place = places.find(pl => p.name.includes(pl));
  p.place = place || "כללי";
  const topic = place
    ? p.name.split(/\s+-\s+/).filter(seg => !seg.trim().startsWith(place)).join(" - ").trim()
    : p.name;
  p.topic = topic || p.name;
}

// ---- 6. כתיבה ----
const sortedVideos = Object.fromEntries(Object.keys(videos).sort().map(id => [id, videos[id]]));
const channelInfo = ({ channel }) => ({
  id: channel.id,
  title: channel.snippet.title,
  url: channel.snippet.customUrl
    ? `https://www.youtube.com/${channel.snippet.customUrl}`
    : `https://www.youtube.com/channel/${channel.id}`,
});
const out = {
  generatedAt: new Date().toISOString(),
  channel: channelInfo(channels[0]),
  ...(channels.length > 1 ? { channels: channels.map(channelInfo) } : {}),
  categories: finalCategories,
  playlists,
  uploads,
  ...(Object.keys(replaces).length ? { replaces } : {}),
  videos: sortedVideos,
};

// generatedAt משתנה בכל ריצה. אם שום דבר אחר לא השתנה, לא כותבים כדי לא ליצור commit ריק.
const strip = s => s.replace(/"generatedAt":"[^"]*"/, "");
const json = JSON.stringify(out);
let prevText = "";
try { prevText = await readFile(OUT_PATH, "utf8"); } catch {}
if (strip(prevText).includes(strip(json))) {
  console.log("אין שינויים.");
} else {
  await writeFile(OUT_PATH, "// נוצר אוטומטית ע\"י scripts/sync.mjs, אין לערוך ידנית\nwindow.LESSONS_DATA = " + json + ";\n");
  console.log(`נכתב ${OUT_PATH}: ${playlists.length} פלייליסטים, ${count} שיעורים (${count - previousCount >= 0 ? "+" : ""}${count - previousCount})`);
}
if (pending.size) console.log("סרטונים שעדיין לא סופיים (ייבדקו שוב):", [...pending].join(", "));
await writeFile(SEEN_PATH, JSON.stringify([...new Set(uploadIds)].filter(id => !pending.has(id)).sort()));
const pendingOut = Object.fromEntries(Object.keys(pendingSig).sort().map(id => [id, pendingSig[id]]));
await writeFile(PENDING_PATH, JSON.stringify(pendingOut));
await writeFile(LAST_FULL_PATH, JSON.stringify({ at: new Date().toISOString() }));
await setOutput("skip", "false");
console.log("יחידות מכסה שנוצלו:", quota, "(מתוך 10,000 ביום)");
