#!/usr/bin/env node
// העתקת קבצי mp3 ו-PDF מהאתר הישן של הישיבה (ateretmordechai.com) אל Cloudflare R2,
// וכתיבת data/media.js שמחבר כל שיעור (לפי מזהה יוטיוב) לקבצים שלו.
//
// אפשר להריץ שוב ושוב: קובץ שכבר קיים ב-R2 באותו גודל מדלגים עליו.
// משתני סביבה:
//   R2_ENDPOINT, R2_BUCKET, AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY  (הסודות של R2)
//   LIMIT      כמה שיעורים להעתיק בריצה אחת (0 = הכול). לדגימה: 5
//   SCOPE      youtube (ברירת מחדל: רק שיעורים שכבר באתר שלנו) | all (גם הקלטות שמע בלבד)
//   RATE_LIMIT הגבלת מהירות הורדה מהאתר הישן (ברירת מחדל 8M = 8MB לשנייה)
//   DRY_RUN=1  בדיקה בלי העלאה
//   LINK_ONLY=1  בלי העתקה, רק קישור קבצים שכבר ב-R2
//   AUTO=1     מצב אוטומטי (רץ בכל בדיקה מהירה): בלי פנייה לאתר הישן (משתמשים ב-data/media-manifest.json השמור),
//              בלי העתקה, ורק מקשרים. שיעורים חדשים מקבלים קבצים לפי התאריך וקוד המקום בשם הקובץ (ראו autoMatch).
// דורש את aws CLI ו-curl (מותקנים ב-GitHub Actions).

import { readFile, writeFile } from "node:fs/promises";
import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import path from "node:path";

const run = promisify(execFile);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SITE = "https://ateretmordechai.com";
const FILES = "https://ateretmordechaifiles.com/mediaFiles";
const RABBI_ID = 49;
const UA = "GinzeiHaim-media-import/1.0 (copy of the rabbi's own lessons; contact via GitHub talsal/Ginzei-Haim)";
const DELAY_MS = 600; // נימוס כלפי השרת של הישיבה

const LIMIT = parseInt(process.env.LIMIT || "0", 10);
const SCOPE = process.env.SCOPE || "youtube";
const DRY = process.env.DRY_RUN === "1";
const AUTO = process.env.AUTO === "1";
const LINK_ONLY = AUTO || process.env.LINK_ONLY === "1"; // בלי העתקה: רק מקשרים קבצים שכבר קיימים ב-R2
const { R2_ENDPOINT, R2_BUCKET } = process.env;
if (!DRY && (!R2_ENDPOINT || !R2_BUCKET)) {
  console.error("חסרים R2_ENDPOINT / R2_BUCKET");
  process.exit(1);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const config = JSON.parse(await readFile(path.join(ROOT, "config.json"), "utf8"));

async function getJSON(url) {
  for (let attempt = 1; ; attempt++) {
    try {
      const res = await fetch(url, { headers: { "user-agent": UA, accept: "application/json" } });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.json();
    } catch (e) {
      if (attempt >= 4) throw new Error(`${url}: ${e.message}`);
      await sleep(2000 * attempt);
    }
  }
}

// ---- 1. רשימת השיעורים באתר הישן (API ציבורי של האתר) ----
async function fetchOldLessons() {
  const out = [];
  for (let page = 1; ; page++) {
    const r = await getJSON(`${SITE}/api/lessons/fast?page=${page}&pageSize=100&rabbiId=${RABBI_ID}`);
    for (const d of r.data) {
      const a = d.attributes;
      const dir = (a.AudioDir || "").replace(/^\/+|\/+$/g, "");
      out.push({
        id: d.id,
        yt: a.youtube_id || "",
        title: a.title,
        main: a.main_category?.data?.attributes?.name || "",
        sub: a.sub_category?.data?.attributes?.name || "",
        date: a.lesson_date_gregorian || "",
        duration: a.duration || "",
        audio: a.AudioFileName && dir ? `${dir}/${a.AudioFileName}` : "",
        pdfs: dir ? [...new Set([...(a.PdfFiles || []), a.PdfFileName].filter(Boolean))].map((f) => `${dir}/${f}`) : [],
      });
    }
    if (page >= (r.meta?.pagination?.pageCount || 1)) break;
    await sleep(DELAY_MS);
  }
  return out;
}

// ---- 2. מזהי הסרטונים שכבר באתר שלנו ----
async function ourVideoIds() {
  const ctx = { window: {} };
  vm.runInNewContext(await readFile(path.join(ROOT, "data", "lessons.js"), "utf8"), ctx);
  const data = ctx.window.LESSONS_DATA;
  // סרטון ישן שהוחלף בסרטון מהערוץ החדש (replaces: חדש -> ישן) ממשיך להיחשב "שלנו",
  // כדי שהקבצים שלו יישארו מקושרים (האתר מפענח אותם דרך replaces) ולא ייווצר שיעור שמע-בלבד כפול
  return new Set([...Object.keys(data.videos || {}), ...Object.values(data.replaces || {})]);
}

// ---- 3. עזרי R2 (דרך aws CLI) ----
const awsArgs = (...a) => [...a, "--endpoint-url", R2_ENDPOINT];
async function listR2() {
  const have = new Map();
  let token;
  do {
    const args = ["s3api", "list-objects-v2", "--bucket", R2_BUCKET, "--output", "json", ...(token ? ["--starting-token", token] : [])];
    const { stdout } = await run("aws", awsArgs(...args), { maxBuffer: 1 << 28 });
    const j = stdout.trim() ? JSON.parse(stdout) : {};
    for (const o of j.Contents || []) have.set(o.Key, o.Size);
    token = j.NextToken;
  } while (token);
  return have;
}

const encodePath = (p) => p.split("/").map(encodeURIComponent).join("/");
const mime = (key) => (key.toLowerCase().endsWith(".pdf") ? "application/pdf" : "audio/mpeg");

async function remoteSize(srcPath) {
  const res = await fetch(`${FILES}/${encodePath(srcPath)}`, { method: "HEAD", headers: { "user-agent": UA } });
  if (!res.ok) throw new Error(`HEAD ${res.status}`);
  return parseInt(res.headers.get("content-length") || "0", 10);
}

function copyOne(srcPath, key) {
  return new Promise((resolve, reject) => {
    const p = spawn(
      "bash",
      ["-c", 'set -o pipefail; curl -fsS --retry 3 --limit-rate "$RATE" -A "$UA" "$SRC" | aws s3 cp - "s3://$BUCKET/$KEY" --endpoint-url "$EP" --content-type "$CT" --only-show-errors'],
      { env: { ...process.env, UA, SRC: `${FILES}/${encodePath(srcPath)}`, BUCKET: R2_BUCKET, KEY: key, EP: R2_ENDPOINT, CT: mime(key), RATE: process.env.RATE_LIMIT || "8M" }, stdio: ["ignore", "inherit", "inherit"] }
    );
    p.on("exit", (c) => (c === 0 ? resolve() : reject(new Error(`copy exit ${c}`))));
  });
}

// ---- main ----
let old;
if (AUTO) {
  old = JSON.parse(await readFile(path.join(ROOT, "data", "media-manifest.json"), "utf8")).lessons;
  console.log(`${old.length} שיעורים ברשימה השמורה של האתר הישן`);
} else {
  console.log("טוען את רשימת השיעורים מהאתר הישן...");
  old = await fetchOldLessons();
  console.log(`${old.length} שיעורים באתר הישן`);
  // מניפסט מלא (לשלבים הבאים, כולל הקלטות שמע בלבד)
  await writeFile(path.join(ROOT, "data", "media-manifest.json"), JSON.stringify({ generatedAt: new Date().toISOString(), lessons: old }));
}

const ours = await ourVideoIds();

const seenYt = new Set();
let targets = old.filter((l) => {
  if (!l.audio && !l.pdfs.length) return false;
  if (!l.yt || !ours.has(l.yt)) return SCOPE === "all"; // הקלטת שמע בלבד: אין לה סרטון באתר
  if (seenYt.has(l.yt)) return false;
  seenYt.add(l.yt);
  return true;
});
console.log(`${targets.length} שיעורים בטווח "${SCOPE}"`);

const have = await listR2();
// התיקיות ב-R2 משקפות את תיקיות האתר הישן בלי הקידומת JH/. אם קובץ נמצא במקום אחר (למשל בתיקייה שהועלתה ידנית), מוצאים אותו לפי שם הקובץ.
const norm = (x) => x.toLowerCase().replace(/[\s_.\-]+/g, "");
const baseOf = (k) => k.split("/").pop();
const byBase = new Map();
const indexKey = (k) => { if (/\.(mp3|pdf)$/i.test(k)) byBase.set(norm(baseOf(k)), k); };
for (const k of have.keys()) indexKey(k);
const keyOf = (pth) => pth.replace(/^JH\//, "");
const find0 = (pth) => (have.has(keyOf(pth)) ? keyOf(pth) : have.has(pth) ? pth : byBase.get(norm(baseOf(pth))) || "");
// סידור תיקיות (data/r2-reorg-plan.json): אם קובץ כבר הועתק לנתיב החדש, מקשרים לנתיב החדש. הישן נשאר ב-R2 כגיבוי.
let reorg = {};
try { reorg = JSON.parse(await readFile(path.join(ROOT, "data", "r2-reorg-plan.json"), "utf8")).prefixes || {}; } catch {}
const moved = (k) => {
  for (const [a, b] of Object.entries(reorg)) if (k && k.startsWith(a)) { const n = b + k.slice(a.length); if (have.has(n)) return n; }
  return k;
};
const find = (pth) => moved(find0(pth));
{
  let exact = 0, byName = 0, missing = 0;
  for (const l of targets) for (const pth of [l.audio, ...l.pdfs].filter(Boolean)) {
    const k = find(pth);
    if (!k) missing++; else if (k === keyOf(pth) || k === pth) exact++; else byName++;
  }
  console.log(`ב-R2 (${have.size} קבצים): ${exact} במקום הצפוי, ${byName} נמצאו לפי שם הקובץ, ${missing} חסרים`);
}
const dryKeys = new Set();
const missingOf = (l) => [l.audio, ...l.pdfs].filter(Boolean).filter((pth) => !find(pth) && !dryKeys.has(keyOf(pth)));
let pending = targets.filter((l) => missingOf(l).length);
console.log(`${pending.length} שיעורים עם קבצים שעוד לא ב-R2`);
if (LINK_ONLY) pending = [];
if (LIMIT) pending = pending.slice(0, LIMIT);

let copied = 0, failed = 0, dryBytes = 0;
for (const l of pending) {
  for (const pth of missingOf(l)) {
    const key = keyOf(pth);
    if (find(pth) || dryKeys.has(key)) continue; // PDF משותף שכבר הועלה בסבב הזה
    try {
      const size = await remoteSize(pth);
      if (DRY) { dryBytes += size; dryKeys.add(key); continue; }
      await copyOne(pth, key);
      const { stdout } = await run("aws", awsArgs("s3api", "head-object", "--bucket", R2_BUCKET, "--key", key, "--output", "json"));
      const got = JSON.parse(stdout).ContentLength;
      if (got !== size) throw new Error(`גודל לא תואם: ${got} במקום ${size}`);
      have.set(key, got);
      indexKey(key);
      copied++;
      console.log(`✓ ${key} (${(got / 1048576).toFixed(1)}MB)`);
    } catch (e) {
      failed++;
      console.error(`✗ ${key}: ${e.message}`);
    }
    await sleep(DELAY_MS);
  }
}

if (DRY) console.log(`בדיקה בלבד: ${(dryBytes / 1e9).toFixed(1)}GB להעתקה, עלות אחסון בערך ${(Math.max(0, dryBytes / 1e9 - 10) * 0.015).toFixed(2)}$ לחודש`);

// ---- 4. data/media.js: מזהה סרטון -> קבצים שקיימים ב-R2 ----
if (DRY) process.exit(0); // בבדיקה בלבד לא נוגעים ב-media.js
const files = {};
for (const l of old) {
  if (!l.yt || !ours.has(l.yt) || files[l.yt]) continue;
  const a = l.audio ? find(l.audio) : "";
  const p = l.pdfs.map(find).filter(Boolean);
  if (a || p.length) files[l.yt] = { ...(a ? { a } : {}), ...(p.length ? { p } : {}) };
}
// ---- הקלטות שמע בלבד (אין סרטון באתר): נכנסות כשיעורים עם מזהה a<מספר> ----
const prefix = config.stripPrefix || "";
const clean = (t) => (prefix && t.startsWith(prefix) ? t.slice(prefix.length) : t).trim() || t;
const places = config.places || [];
const categoryFor = (name) => {
  for (const c of config.categories || []) if ((c.keywords || []).some((k) => k && name.includes(k))) return c.key;
  return "other";
};
const extra = { videos: {}, playlists: [] };
const plByName = new Map();
for (const l of old) {
  if (l.yt && ours.has(l.yt)) continue;
  const audioKey = l.audio ? find(l.audio) : "";
  if (!audioKey) continue;
  const id = "a" + l.id;
  const pdfs = l.pdfs.map(find).filter(Boolean);
  extra.videos[id] = {
    title: clean(l.title), duration: l.duration, published: l.date, views: 0, audioOnly: true,
  };
  files[id] = { a: audioKey, ...(pdfs.length ? { p: pdfs } : {}) };
  const name = clean(l.sub || l.main || "שיעורים נוספים");
  const full = `${name} ${l.main}`;
  const place = places.find((pl) => full.includes(pl)) || "כללי";
  let pl = plByName.get(name);
  if (!pl) {
    const topic = place !== "כללי"
      ? name.split(/\s+-\s+/).filter((seg) => !seg.trim().startsWith(place)).join(" - ").trim() || name
      : name;
    pl = { id: "a-" + plByName.size, name, description: "", category: categoryFor(name), place, topic, videoIds: [] };
    plByName.set(name, pl);
    extra.playlists.push(pl);
  }
  pl.videoIds.push(id);
}
for (const pl of extra.playlists) pl.videoIds.sort((a, b) => (extra.videos[b].published || "").localeCompare(extra.videos[a].published || ""));

// ---- שיעורים חדשים (לא באתר הישן): התאמה לפי שם הקובץ, ותיקונים ידניים ----
const { autoMatch } = await import("./media-match.mjs");
// בלי העותקים הישנים של קבצים שכבר הועתקו לנתיב חדש
const current = [...have.keys()].filter((k) => moved(k) === k);
let overrides = {};
try { overrides = JSON.parse(await readFile(path.join(ROOT, "data", "media-overrides.json"), "utf8")); } catch {}
const ovr = Object.entries(overrides).filter(([id, o]) => !id.startsWith("_") && o && typeof o === "object");
// שיעור שנקבע לו שמע ידנית (גם "בלי שמע") לא מקבל התאמה אוטומטית, וקובץ שהוצמד ידנית לא יוצמד אוטומטית לשיעור אחר
// תאריך ידני (YYYY-MM-DD) וקישור ידני לסרטון ביוטיוב: גוברים על מה שנקרא אוטומטית (האתר מחיל אותם מתוך media.js)
const over = {};
for (const [id, o] of ovr) {
  const d = /^\d{4}-\d\d-\d\d$/.test(o.date || "") ? o.date : "";
  const v = /^[A-Za-z0-9_-]{11}$/.test(o.link || "") ? o.link : "";
  if (d || v) over[id] = { ...(d ? { d } : {}), ...(v ? { v } : {}) };
}
const report = autoMatch({
  dates: Object.fromEntries(Object.entries(over).filter(([, x]) => x.d).map(([id, x]) => [id, x.d])),
  files, have: current, lessonsPath: path.join(ROOT, "data", "lessons.js"), config,
  skip: new Set(ovr.filter(([, o]) => "a" in o).map(([id]) => id)),
  reserved: new Set(ovr.map(([, o]) => o.a).filter(Boolean)),
});
// רשימת הקבצים ב-R2, בשביל דף הניהול
await writeFile(
  path.join(ROOT, "data", "r2-files.json"),
  JSON.stringify(current.filter((k) => /\.(mp3|pdf)$/i.test(k)).sort()) + "\n"
);
for (const [id, o] of ovr) {
  const f = { ...(files[id] || {}) };
  if ("a" in o) { if (o.a) f.a = o.a; else delete f.a; }
  if ("p" in o) { if (o.p && o.p.length) f.p = o.p; else delete f.p; }
  if (f.a || f.p) files[id] = f; else delete files[id];
}
await writeFile(path.join(ROOT, "data", "media-report.json"), JSON.stringify(report, null, 1) + "\n");
console.log(`התאמה אוטומטית: ${report.linked.length} שיעורים קושרו, ${report.unmatched.length} שיעורים אחרונים עדיין בלי שמע`);

const base = (config.mediaBaseUrl || "").replace(/\/+$/, "");
await writeFile(
  path.join(ROOT, "data", "media.js"),
  `// נוצר אוטומטית ע"י scripts/media-import.mjs, אין לערוך ידנית\nwindow.MEDIA_DATA = ${JSON.stringify({ base, files, extra, ...(Object.keys(over).length ? { over } : {}) })};\n`
);
console.log(`הועתקו ${copied}, נכשלו ${failed}. ב-media.js: ${Object.keys(files).length} שיעורים (מהם ${Object.keys(extra.videos).length} שמע בלבד)`);
if (failed) process.exitCode = 1;
