#!/usr/bin/env node
// העתקת קבצי mp3 ו-PDF מהאתר הישן של הישיבה (ateretmordechai.com) אל Cloudflare R2,
// וכתיבת data/media.js שמחבר כל שיעור (לפי מזהה יוטיוב) לקבצים שלו.
//
// אפשר להריץ שוב ושוב: קובץ שכבר קיים ב-R2 באותו גודל מדלגים עליו.
// משתני סביבה:
//   R2_ENDPOINT, R2_BUCKET, AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY  (הסודות של R2)
//   LIMIT      כמה שיעורים להעתיק בריצה אחת (0 = הכול). לדגימה: 5
//   SCOPE      youtube (ברירת מחדל: רק שיעורים שכבר באתר שלנו) | all (גם הקלטות שמע בלבד)
//   DRY_RUN=1  בדיקה בלי העלאה
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
        date: a.lesson_date_gregorian || "",
        duration: a.duration || "",
        audio: a.AudioFileName && dir ? `${dir}/${a.AudioFileName}` : "",
        pdfs: dir ? (a.PdfFiles || []).filter(Boolean).map((f) => `${dir}/${f}`) : [],
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
  return new Set(Object.keys(ctx.window.LESSONS_DATA.videos || {}));
}

// ---- 3. עזרי R2 (דרך aws CLI) ----
const awsArgs = (...a) => [...a, "--endpoint-url", R2_ENDPOINT];
async function listR2() {
  const have = new Map();
  if (DRY) return have;
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

async function remoteSize(key) {
  const res = await fetch(`${FILES}/${encodePath(key)}`, { method: "HEAD", headers: { "user-agent": UA } });
  if (!res.ok) throw new Error(`HEAD ${res.status}`);
  return parseInt(res.headers.get("content-length") || "0", 10);
}

function copyOne(key) {
  return new Promise((resolve, reject) => {
    const p = spawn(
      "bash",
      ["-c", 'set -o pipefail; curl -fsS --retry 3 -A "$UA" "$SRC" | aws s3 cp - "s3://$BUCKET/$KEY" --endpoint-url "$EP" --content-type "$CT" --only-show-errors'],
      { env: { ...process.env, UA, SRC: `${FILES}/${encodePath(key)}`, BUCKET: R2_BUCKET, KEY: key, EP: R2_ENDPOINT, CT: mime(key) }, stdio: ["ignore", "inherit", "inherit"] }
    );
    p.on("exit", (c) => (c === 0 ? resolve() : reject(new Error(`copy exit ${c}`))));
  });
}

// ---- main ----
console.log("טוען את רשימת השיעורים מהאתר הישן...");
const old = await fetchOldLessons();
console.log(`${old.length} שיעורים באתר הישן`);

const ours = await ourVideoIds();
// מניפסט מלא (לשלבים הבאים, כולל הקלטות שמע בלבד)
await writeFile(path.join(ROOT, "data", "media-manifest.json"), JSON.stringify({ generatedAt: new Date().toISOString(), lessons: old }));

const seenYt = new Set();
let targets = old.filter((l) => {
  if (!l.audio && !l.pdfs.length) return false;
  if (SCOPE === "youtube") {
    if (!l.yt || !ours.has(l.yt) || seenYt.has(l.yt)) return false;
    seenYt.add(l.yt);
  }
  return true;
});
console.log(`${targets.length} שיעורים בטווח "${SCOPE}"`);

const have = await listR2();
const missingOf = (l) => [l.audio, ...l.pdfs].filter(Boolean).filter((k) => !have.has(k));
let pending = targets.filter((l) => missingOf(l).length);
console.log(`${pending.length} שיעורים עם קבצים שעוד לא ב-R2`);
if (LIMIT) pending = pending.slice(0, LIMIT);

let copied = 0, failed = 0;
for (const l of pending) {
  for (const key of missingOf(l)) {
    if (have.has(key)) continue; // PDF משותף שכבר הועלה בסבב הזה
    try {
      const size = await remoteSize(key);
      if (DRY) { console.log(`[dry] ${key} (${size})`); continue; }
      await copyOne(key);
      const { stdout } = await run("aws", awsArgs("s3api", "head-object", "--bucket", R2_BUCKET, "--key", key, "--output", "json"));
      const got = JSON.parse(stdout).ContentLength;
      if (got !== size) throw new Error(`גודל לא תואם: ${got} במקום ${size}`);
      have.set(key, got);
      copied++;
      console.log(`✓ ${key} (${(got / 1048576).toFixed(1)}MB)`);
    } catch (e) {
      failed++;
      console.error(`✗ ${key}: ${e.message}`);
    }
    await sleep(DELAY_MS);
  }
}

// ---- 4. data/media.js: מזהה סרטון -> קבצים שקיימים ב-R2 ----
const files = {};
for (const l of old) {
  if (!l.yt || !ours.has(l.yt) || files[l.yt]) continue;
  const a = l.audio && have.has(l.audio) ? l.audio : "";
  const p = l.pdfs.filter((k) => have.has(k));
  if (a || p.length) files[l.yt] = { ...(a ? { a } : {}), ...(p.length ? { p } : {}) };
}
const base = (config.mediaBaseUrl || "").replace(/\/+$/, "");
await writeFile(
  path.join(ROOT, "data", "media.js"),
  `// נוצר אוטומטית ע"י scripts/media-import.mjs, אין לערוך ידנית\nwindow.MEDIA_DATA = ${JSON.stringify({ base, files })};\n`
);
console.log(`הועתקו ${copied}, נכשלו ${failed}. ב-media.js: ${Object.keys(files).length} שיעורים`);
if (failed) process.exitCode = 1;
