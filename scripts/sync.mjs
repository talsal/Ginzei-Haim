#!/usr/bin/env node
// סנכרון השיעורים מערוץ היוטיוב אל data/lessons.js
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
const QUICK = process.env.QUICK === "1";
const API = "https://www.googleapis.com/youtube/v3/";

const KEY = process.env.YT_API_KEY;
if (!KEY) {
  console.error("חסר YT_API_KEY (מפתח YouTube Data API)");
  process.exit(1);
}

const config = JSON.parse(await readFile(CONFIG_PATH, "utf8"));
let quota = 0;

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

// ---- 1. הערוץ ----
const channelParams = config.channelId
  ? { id: config.channelId }
  : { forHandle: config.channelHandle };
const ch = await api("channels", { part: "snippet,contentDetails", ...channelParams });
if (!ch.items || !ch.items.length) throw new Error("הערוץ לא נמצא: " + JSON.stringify(channelParams));
const channel = ch.items[0];
const uploadsId = channel.contentDetails.relatedPlaylists.uploads;
console.log("ערוץ:", channel.snippet.title);

async function setOutput(k, v) {
  if (process.env.GITHUB_OUTPUT) await appendFile(process.env.GITHUB_OUTPUT, `${k}=${v}\n`);
}

// ---- בדיקה מהירה: האם הועלה סרטון חדש מאז הסנכרון הקודם? (2 יחידות מכסה) ----
if (QUICK) {
  let seen = null;
  try { seen = new Set(JSON.parse(await readFile(SEEN_PATH, "utf8"))); } catch {}
  if (seen) {
    const first = await api("playlistItems", { part: "contentDetails", playlistId: uploadsId, maxResults: 50 });
    let pendingPrev = {};
    try { pendingPrev = JSON.parse(await readFile(PENDING_PATH, "utf8")); } catch {}
    const unseen = (first.items || []).map(i => i.contentDetails && i.contentDetails.videoId).filter(id => id && !seen.has(id));
    // סרטון שכבר באתר כ"לא סופי": בודקים אם מצבו השתנה (יחידת מכסה אחת לכל 50)
    const waiting = unseen.filter(id => id in pendingPrev);
    const fresh = unseen.filter(id => !(id in pendingPrev));
    for (let i = 0; i < waiting.length; i += 50) {
      const batch = waiting.slice(i, i + 50);
      const data = await api("videos", { part: "snippet,contentDetails,status", id: batch.join(",") });
      const byId = Object.fromEntries((data.items || []).map(v => [v.id, v]));
      for (const id of batch) if (signature(byId[id]) !== pendingPrev[id]) fresh.push(id);
    }
    if (!fresh.length) {
      console.log("אין סרטונים חדשים בערוץ, מדלג.");
      await setOutput("skip", "true");
      process.exit(0);
    }
    console.log("נמצאו סרטונים חדשים:", fresh.join(", "));
  }
}

// ---- 2. הפלייליסטים ----
const exclude = new Set(config.excludePlaylistIds || []);
const rawPlaylists = (await paged("playlists", { part: "snippet,contentDetails", channelId: channel.id }))
  .filter(p => !exclude.has(p.id));
console.log("פלייליסטים:", rawPlaylists.length);

async function playlistVideoIds(playlistId) {
  const items = await paged("playlistItems", { part: "contentDetails", playlistId });
  return items.map(i => i.contentDetails && i.contentDetails.videoId).filter(Boolean);
}

const uploadIds = await playlistVideoIds(uploadsId);
const playlistIds = {};
for (const p of rawPlaylists) playlistIds[p.id] = await playlistVideoIds(p.id);

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
  const data = await api("videos", { part: "snippet,contentDetails,status,statistics,liveStreamingDetails", id: batch.join(",") });
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
      views: Number((v.statistics && v.statistics.viewCount) || 0),
      ...(live ? { live } : {}),
      ...(live === "upcoming" && start ? { startsAt: start } : {}),
    };
  }
}
// ---- סינון: רק שיעורי הרב ----
const f = config.filter || {};
const kws = (f.keywords || []).filter(Boolean);
const keepIds = new Set((f.playlistIds || []).flatMap(id => playlistIds[id] || []));
if (kws.length || keepIds.size) {
  for (const id of Object.keys(videos)) {
    const text = videos[id].title + " " + videos[id].description;
    if (!keepIds.has(id) && !kws.some(k => text.includes(k))) delete videos[id];
  }
  console.log("אחרי סינון לפי הרב:", Object.keys(videos).length);
}
for (const v of Object.values(videos)) delete v.description;
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
  .sort((a, b) => (videos[b].published || "").localeCompare(videos[a].published || ""));
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
const out = {
  generatedAt: new Date().toISOString(),
  channel: {
    id: channel.id,
    title: channel.snippet.title,
    url: channel.snippet.customUrl
      ? `https://www.youtube.com/${channel.snippet.customUrl}`
      : `https://www.youtube.com/channel/${channel.id}`,
  },
  categories: finalCategories,
  playlists,
  uploads,
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
await setOutput("skip", "false");
console.log("יחידות מכסה שנוצלו:", quota, "(מתוך 10,000 ביום)");
