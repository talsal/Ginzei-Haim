#!/usr/bin/env node
// מעלה את שיעורי הרב מהמחשב לערוץ החדש ביוטיוב (@ginzei-haim), ומעתיק לכל שיעור את הכותרת, התיאור והסדרה (פלייליסט)
// מהשיעור המקביל בערוץ הישן. בלי תלויות, צריך רק Node.js 18 ומעלה.
//
//   node ginzei-youtube.mjs                  מעלה שיעורים מהתיקייה (ומתקן קודם סרטונים שכבר הועלו ידנית)
//   node ginzei-youtube.mjs --fix-only       רק מתקן כותרת/תיאור/סדרה לסרטונים שכבר בערוץ החדש (למשל שהועלו ב-Studio)
//   node ginzei-youtube.mjs --dry-run        רק דוח (report.csv), לא משנה ולא מעלה כלום
//   node ginzei-youtube.mjs --keep-going     כשנגמרת המכסה היומית, ממתין ללילה וממשיך לבד עד הסוף
//   node ginzei-youtube.mjs --folder "נתיב"  תיקיית הוידאו (נשמרת ל-settings.json)
//   node ginzei-youtube.mjs --limit 3        מקסימום העלאות בריצה
//   node ginzei-youtube.mjs --careful        מתקן רק התאמות שאושרו גם לפי שם (לא לפי משך בלבד)
//   node ginzei-youtube.mjs --login          התחברות מחדש (שימו לב: אחרי ההתחברות הכלי ממשיך מיד לשלב התיקון ולהעלאה. לבדיקה בלבד להריץ קודם עם --dry-run)
//
// קבצים בתיקייה: client_secret.json (מ-Google Cloud), token.json (נוצר בהתחברות), state.json (מה כבר טופל),
// settings.json (תיקיית הוידאו, privacy), file-map.csv (אופציונלי: שם קובץ,מזהה שיעור ישן), report.csv (דוח בכל ריצה),
// lessons-list.json (השיעורים בערוץ הישן, נוצר ע"י build-list.mjs).

import { readFile, writeFile, readdir, stat, open } from "node:fs/promises";
import { createInterface } from "node:readline/promises";
import { createServer } from "node:http";
import { createHash, randomBytes } from "node:crypto";
import { exec } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { matchVideo, matchFile, VIDEO_EXT } from "./match.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const P = (f) => path.resolve(HERE, f);
const args = new Set(process.argv.slice(2));
const DRY = args.has("--dry-run");
const CAREFUL = args.has("--careful");
const argv = process.argv.slice(2);
const argVal = (k) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : undefined; };
const LIMIT = Number(argVal("--limit") || 0);
const NEW_CHANNEL_ID = "UCvrueqpp5TJdrfW6M0zdg7Q"; // @ginzei-haim
const SCOPE = "https://www.googleapis.com/auth/youtube";
const API = "https://www.googleapis.com/youtube/v3";
const DAILY_QUOTA = 9500; // השארנו מרווח מתוך 10,000
const UPLOAD_COST = 1; // מכסה נפרדת: 100 העלאות ביום, עלות 1 להעלאה (תיעוד גוגל, נובמבר 2026). לא להחזיר ל-1600
const CHUNK = 64 * 256 * 1024; // 16MB

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// בענן (GitHub Actions) הסודות מגיעים ממשתני סביבה, והמצב והדוח נשמרים בנתיבים שבמשתנים STATE_FILE ו-REPORT_FILE.
const STATE_FILE = process.env.STATE_FILE || "state.json";
const REPORT_FILE = process.env.REPORT_FILE || "report.csv";
const CLOUD = !!process.env.YT_REFRESH_TOKEN;
const readJSON = async (f, d) => { try { return JSON.parse(await readFile(P(f), "utf8")); } catch { return d; } };
const writeJSON = (f, v) => writeFile(P(f), JSON.stringify(v, null, 1));
const log = (...a) => console.log(...a);

class Stop extends Error {}

// ---------- התחברות ----------
async function openBrowser(url) {
  const cmd = process.platform === "win32" ? `start "" "${url}"` : process.platform === "darwin" ? `open "${url}"` : `xdg-open "${url}"`;
  exec(cmd, () => {});
}

async function login(client) {
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  const state = randomBytes(8).toString("hex");
  const code = await new Promise((resolve, reject) => {
    const srv = createServer((req, res) => {
      const u = new URL(req.url, "http://127.0.0.1");
      if (!u.searchParams.has("code") && !u.searchParams.has("error")) { res.end(); return; }
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end("<meta charset=utf-8><body style='font-family:sans-serif;text-align:center;margin-top:15vh;direction:rtl'><h2>ההתחברות הצליחה</h2><p>אפשר לסגור את החלון הזה ולחזור לחלון השחור.</p>");
      srv.close();
      if (u.searchParams.get("state") !== state) return reject(new Error("תשובת התחברות לא תקינה"));
      u.searchParams.has("error") ? reject(new Error("ההתחברות בוטלה: " + u.searchParams.get("error"))) : resolve({ code: u.searchParams.get("code"), redirect });
    });
    let redirect;
    srv.listen(0, "127.0.0.1", () => {
      redirect = `http://127.0.0.1:${srv.address().port}`;
      const url = "https://accounts.google.com/o/oauth2/v2/auth?" + new URLSearchParams({
        client_id: client.client_id, redirect_uri: redirect, response_type: "code", scope: SCOPE,
        code_challenge: challenge, code_challenge_method: "S256", access_type: "offline", prompt: "consent", state,
      });
      log("\nנפתח דפדפן להתחברות. התחברו עם חשבון הגוגל של ערוץ 'גנזי חיים' ובחרו בערוץ עצמו.");
      log("אם הדפדפן לא נפתח, פתחו ידנית את הכתובת:\n" + url + "\n");
      openBrowser(url);
    });
  });
  const tok = await tokenRequest(client, { grant_type: "authorization_code", code: code.code, redirect_uri: code.redirect, code_verifier: verifier });
  await writeJSON("token.json", { refresh_token: tok.refresh_token });
  log("\nההתחברות הצליחה. הערך refresh_token שב-token.json הוא מה שמעתיקים לסוד YT_REFRESH_TOKEN בענן (לא לשלוח אותו בצ'אט).");
  return tok.access_token;
}

async function tokenRequest(client, body) {
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: client.client_id, client_secret: client.client_secret, ...body }),
  });
  const j = await res.json();
  if (!res.ok) throw Object.assign(new Error(j.error_description || j.error), { code: j.error });
  return j;
}

let accessToken = "";
let client = null;
async function authorize(force = false) {
  const cs = process.env.YT_CLIENT_ID
    ? { installed: { client_id: process.env.YT_CLIENT_ID, client_secret: process.env.YT_CLIENT_SECRET } }
    : await readJSON("client_secret.json", null);
  if (!cs) throw new Stop("חסר הקובץ client_secret.json בתיקייה (ראו את המדריך).");
  client = cs.installed || cs.web;
  const saved = CLOUD ? { refresh_token: process.env.YT_REFRESH_TOKEN } : force ? null : await readJSON("token.json", null);
  if (saved && saved.refresh_token) {
    try {
      accessToken = (await tokenRequest(client, { grant_type: "refresh_token", refresh_token: saved.refresh_token })).access_token;
      return;
    } catch (e) {
      if (e.code !== "invalid_grant") throw e;
      if (CLOUD) throw new Stop("ההרשאה (YT_REFRESH_TOKEN) פגה או בוטלה. צריך להתחבר מחדש (node ginzei-youtube.mjs --login) ולעדכן את הסוד ב-GitHub.");
      log("ההרשאה פגה, מתחברים מחדש.");
    }
  }
  accessToken = await login(client);
}

// ---------- קריאות ל-API ----------
const state = await readJSON(STATE_FILE, {});
state.done ||= {}; state.quota ||= { day: "", used: 0 }; state.oldMeta ||= {}; state.sessions ||= {}; state.files ||= {};
const ptDay = () => new Date().toLocaleDateString("en-CA", { timeZone: "America/Los_Angeles" });
if (state.quota.day !== ptDay()) state.quota = { day: ptDay(), used: 0 };
const save = () => writeJSON(STATE_FILE, state);

async function api(method, endpoint, params = {}, body, cost = 1, retried = false) {
  if (method !== "GET" && state.quota.used + cost > DAILY_QUOTA) throw new Stop("הגענו למכסה היומית של יוטיוב. מריצים שוב מחר (המכסה מתאפסת בלילה שעון ארה\"ב, בערך 10:00 בבוקר בישראל), וממשיכים מאותו מקום.");
  const url = `${API}/${endpoint}?` + new URLSearchParams(params);
  for (let attempt = 1; ; attempt++) {
    let res;
    try {
      res = await fetch(url, { method, headers: { authorization: `Bearer ${accessToken}`, ...(body ? { "content-type": "application/json" } : {}) }, body: body ? JSON.stringify(body) : undefined });
    } catch (e) {
      if (attempt >= 4) throw e;
      await sleep(2000 * attempt);
      continue;
    }
    if (res.status === 401 && !retried) { await authorize(); return api(method, endpoint, params, body, cost, true); }
    if (res.status >= 500 && attempt < 4) { await sleep(2000 * attempt); continue; }
    const text = await res.text();
    const j = text ? JSON.parse(text) : {};
    state.quota.used += cost;
    if (!res.ok) {
      const reason = (j.error && j.error.errors && j.error.errors[0] && j.error.errors[0].reason) || "";
      if (/quotaExceeded|dailyLimitExceeded|rateLimitExceeded/.test(reason)) {
        state.quota.used = DAILY_QUOTA;
        await save();
        throw new Stop("יוטיוב הודיע שנגמרה המכסה היומית. מריצים שוב מחר, וממשיכים מאותו מקום.");
      }
      throw Object.assign(new Error(`${endpoint}: ${(j.error && j.error.message) || res.status}`), { reason, status: res.status });
    }
    return j;
  }
}

async function listAll(endpoint, params) {
  const out = [];
  let pageToken;
  do {
    const j = await api("GET", endpoint, { ...params, maxResults: 50, ...(pageToken ? { pageToken } : {}) });
    out.push(...(j.items || []));
    pageToken = j.nextPageToken;
  } while (pageToken);
  return out;
}

function isoSeconds(d) {
  const m = /PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/.exec(d || "");
  return m ? (+m[1] || 0) * 3600 + (+m[2] || 0) * 60 + (+m[3] || 0) : 0;
}

// ---------- העלאה ----------
const MIME = { ".mp4": "video/mp4", ".mov": "video/quicktime", ".mkv": "video/x-matroska", ".avi": "video/x-msvideo", ".wmv": "video/x-ms-wmv", ".m4v": "video/x-m4v", ".webm": "video/webm", ".mpg": "video/mpeg", ".mpeg": "video/mpeg", ".flv": "video/x-flv", ".3gp": "video/3gpp" };

async function walk(dir, out = []) {
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) await walk(p, out);
    else if (VIDEO_EXT.has(path.extname(e.name).toLowerCase()) && !e.name.startsWith(".")) out.push(p);
  }
  return out;
}

async function sessionStatus(url, size) {
  const res = await fetch(url, { method: "PUT", headers: { "content-range": `bytes */${size}`, authorization: `Bearer ${accessToken}` } });
  if (res.status === 200 || res.status === 201) return { done: await res.json() };
  if (res.status === 308) { const m = /bytes=0-(\d+)/.exec(res.headers.get("range") || ""); return { offset: m ? +m[1] + 1 : 0 }; }
  if (res.status === 404 || res.status === 410) return { gone: true };
  throw new Error("מצב העלאה לא צפוי: " + res.status);
}

// מעלה קובץ לפי כתובת session (resumable). מחזיר את אובייקט הסרטון, או { gone:true } אם ה-session פג.
async function sendFile(url, file, size, label) {
  const fh = await open(file, "r");
  try {
    let st = await sessionStatus(url, size).catch(() => ({ offset: 0 }));
    if (st.done) return st.done;
    if (st.gone) return { gone: true };
    let offset = st.offset || 0;
    let fails = 0;
    while (true) {
      const end = Math.min(offset + CHUNK, size) - 1;
      const buf = Buffer.alloc(end - offset + 1);
      await fh.read(buf, 0, buf.length, offset);
      try {
        const res = await fetch(url, { method: "PUT", headers: { "content-range": `bytes ${offset}-${end}/${size}`, authorization: `Bearer ${accessToken}` }, body: buf });
        if (res.status === 200 || res.status === 201) { process.stdout.write("\r" + " ".repeat(70) + "\r"); return await res.json(); }
        if (res.status === 308) {
          const m = /bytes=0-(\d+)/.exec(res.headers.get("range") || "");
          offset = m ? +m[1] + 1 : 0;
          fails = 0;
          process.stdout.write(`\r  ${label}: ${Math.floor((offset / size) * 100)}%   `);
          continue;
        }
        if (res.status === 401) { await authorize(); continue; }
        if (res.status === 404 || res.status === 410) return { gone: true };
        throw new Error("HTTP " + res.status);
      } catch (e) {
        if (++fails > 8) throw new Error("ההעלאה נקטעה (" + e.message + "). מריצים שוב, וממשיכים מאותה נקודה.");
        await sleep(3000 * fails);
        const s2 = await sessionStatus(url, size).catch(() => null);
        if (s2 && s2.done) return s2.done;
        if (s2 && s2.gone) return { gone: true };
        if (s2 && s2.offset !== undefined) offset = s2.offset;
      }
    }
  } finally {
    await fh.close();
  }
}

async function startSession(meta, size, mime) {
  for (let retried = false; ; retried = true) {
    const res = await fetch("https://www.googleapis.com/upload/youtube/v3/videos?" + new URLSearchParams({ uploadType: "resumable", part: "snippet,status,recordingDetails" }), {
      method: "POST",
      headers: { authorization: `Bearer ${accessToken}`, "content-type": "application/json; charset=UTF-8", "x-upload-content-length": String(size), "x-upload-content-type": mime },
      body: JSON.stringify(meta),
    });
    if (res.status === 401 && !retried) { await authorize(); continue; }
    if (!res.ok) {
      const j = await res.json().catch(() => ({}));
      const reason = (j.error && j.error.errors && j.error.errors[0] && j.error.errors[0].reason) || "";
      if (/quotaExceeded|dailyLimitExceeded|rateLimitExceeded/.test(reason)) { state.quota.used = DAILY_QUOTA; await save(); throw new Stop("יוטיוב הודיע שנגמרה המכסה היומית. מריצים שוב מחר, וממשיכים מאותו מקום."); }
      if (/uploadLimitExceeded/.test(reason)) { state.quota.used = DAILY_QUOTA; await save(); throw new Stop("הערוץ הגיע למגבלת ההעלאות היומית של יוטיוב (אימות טלפון של הערוץ מעלה אותה). מריצים שוב מחר."); }
      throw new Error("פתיחת העלאה נכשלה: " + ((j.error && j.error.message) || res.status));
    }
    state.quota.used += UPLOAD_COST;
    return res.headers.get("location");
  }
}

// ---------- ריצה ----------
async function ensurePlaylists(videoId, entry, rec, ctx) {
  for (const name of entry.playlists) {
    if (rec.playlists.includes(name)) continue;
    if (!ctx.playlists) {
      ctx.playlists = {};
      for (const p of await listAll("playlists", { part: "snippet", mine: "true" })) ctx.playlists[p.snippet.title.trim()] = p.id;
    }
    if (!ctx.playlists[name]) {
      const d = ((ctx.list.playlists || []).find((p) => p.name === name) || {}).description || "";
      const created = await api("POST", "playlists", { part: "snippet,status" }, { snippet: { title: name, description: d }, status: { privacyStatus: "public" } }, 50);
      ctx.playlists[name] = created.id;
    }
    for (let attempt = 1; ; attempt++) {
      try {
        await api("POST", "playlistItems", { part: "snippet" }, { snippet: { playlistId: ctx.playlists[name], resourceId: { kind: "youtube#video", videoId } } }, 50);
        break;
      } catch (e) {
        if (attempt >= 4 || !/videoNotFound|backendError/.test(e.reason || "")) throw e;
        await sleep(5000);
      }
    }
    rec.playlists.push(name);
    await save();
  }
}

async function fetchOldMeta(ids) {
  const need = ids.filter((id) => !state.oldMeta[id]);
  for (let i = 0; i < need.length; i += 50) {
    const j = await api("GET", "videos", { part: "snippet", id: need.slice(i, i + 50).join(",") });
    for (const o of j.items || []) state.oldMeta[o.id] = { title: o.snippet.title, description: o.snippet.description || "", tags: o.snippet.tags || [] };
  }
}
const detailsOf = (entry) => {
  const old = state.oldMeta[entry.id];
  return { title: (old && old.title) || entry.title, description: old && old.description.trim() ? old.description : entry.description, tags: (old && old.tags) || [] };
};

async function run(list) {
  await authorize(args.has("--login"));
  const me = await api("GET", "channels", { part: "snippet,contentDetails", mine: "true" });
  const ch = (me.items || [])[0];
  if (!ch) throw new Stop("לא נמצא ערוץ בחשבון שהתחבר.");
  if (ch.id !== NEW_CHANNEL_ID) {
    if (!CLOUD) await writeFile(P("token.json"), "{}");
    throw new Stop(`התחברתם לערוץ "${ch.snippet.title}" ולא לערוץ גנזי חיים. מריצים שוב ובוחרים את הערוץ הנכון.`);
  }
  log(`מחוברים לערוץ: ${ch.snippet.title}`);

  const items = await listAll("playlistItems", { part: "contentDetails", playlistId: ch.contentDetails.relatedPlaylists.uploads });
  const vids = [];
  const ids = items.map((i) => i.contentDetails.videoId);
  for (let i = 0; i < ids.length; i += 50) vids.push(...((await api("GET", "videos", { part: "snippet,contentDetails,status", id: ids.slice(i, i + 50).join(",") })).items || []));
  log(`בערוץ החדש ${vids.length} סרטונים.`);

  const ctx = { list, playlists: null };
  const doneOld = new Set(Object.values(state.done).map((d) => d.oldId));
  const rows = [];
  const fixes = [];
  for (const v of vids) {
    const d = state.done[v.id];
    if (d && d.finished) continue;
    const seconds = isoSeconds(v.contentDetails.duration);
    if (!seconds) { rows.push([v.id, v.snippet.title, "", "", "עדיין בעיבוד ביוטיוב, יטופל בריצה הבאה"]); continue; }
    const m = d ? { entry: list.lessons.find((l) => l.id === d.oldId), how: "מהריצה הקודמת", sure: true } : matchVideo({ title: v.snippet.title, seconds }, list.lessons, doneOld);
    if (!m || !m.entry) {
      rows.push([v.id, v.snippet.title, "", "", m && m.ambiguous ? `לא חד-משמעי (${m.note || "כמה אפשרויות"}): ${m.ambiguous.join(" ")}` : "לא נמצא שיעור מתאים בערוץ הישן (אולי שיעור חדש)"]);
      continue;
    }
    if (!m.sure && CAREFUL) { rows.push([v.id, v.snippet.title, m.entry.id, m.entry.title, "התאמה לפי משך בלבד, לא עודכן (מצב --careful)"]); continue; }
    doneOld.add(m.entry.id);
    fixes.push({ v, entry: m.entry, how: m.how, sure: m.sure });
  }
  fixes.sort((a, b) => a.entry.date.localeCompare(b.entry.date));
  await fetchOldMeta(fixes.map((f) => f.entry.id));

  let fixed = 0, uploaded = 0, stopped = "", quotaStop = false;
  const finish = (e) => { if (!(e instanceof Stop)) throw e; stopped = e.message; quotaStop = /מכסה|מגבלת/.test(e.message); };
  try {
    // א. תיקון פרטים לסרטונים שכבר בערוץ
    for (const { v, entry, how, sure } of fixes) {
      const det = detailsOf(entry);
      const note = [how, sure ? "" : "(לפי משך בלבד)"].join(" ").trim();
      if (DRY) { rows.push([v.id, v.snippet.title, entry.id, det.title, `היה מעודכן: ${note}; סדרות: ${entry.playlists.join(" | ") || "אין"}`]); continue; }
      const rec = (state.done[v.id] ||= { oldId: entry.id, details: false, playlists: [], finished: false });
      if (!rec.details) {
        await api("PUT", "videos", { part: "snippet" }, { id: v.id, snippet: { title: det.title, description: det.description, categoryId: v.snippet.categoryId || "27", tags: det.tags, defaultLanguage: v.snippet.defaultLanguage || "he" } }, 50);
        rec.details = true;
        await save();
      }
      await ensurePlaylists(v.id, entry, rec, ctx);
      rec.finished = true;
      await save();
      fixed++;
      log(`✓ עודכן: ${det.title}`);
      rows.push([v.id, v.snippet.title, entry.id, det.title, `עודכן (${note})`]);
    }

    // ב. העלאה מהתיקייה
    if (!args.has("--fix-only")) await uploadFolder(list, ctx, doneOld, rows, (n) => { uploaded += n; });
  } catch (e) { finish(e); }

  const csv = ["קובץ או סרטון,שם בערוץ (לפני),שיעור ישן,כותרת,מצב", ...rows.map((r) => r.map((c) => `"${String(c).replace(/"/g, '""')}"`).join(","))].join("\n");
  await writeFile(P(REPORT_FILE), "﻿" + csv + "\n");
  await save();
  const unmatched = rows.filter((r) => /לא נמצא|לא חד/.test(r[4])).length;
  log(DRY ? `\nבדיקה בלבד: ${fixes.length} סרטונים בערוץ יתוקנו. הפירוט ב-report.csv` : `\nסיום: הועלו ${uploaded}, תוקנו ${fixed}, ללא התאמה ${unmatched}. הפירוט ב-report.csv`);
  if (stopped) log("\n" + stopped);
  return { quotaStop };
}

async function uploadFolder(list, ctx, doneOld, rows, count) {
  const settings = await readJSON("settings.json", {});
  let folder = argVal("--folder") || settings.videosFolder;
  if (!folder) {
    if (!process.stdin.isTTY) { log("לא הוגדרה תיקיית וידאו (--folder), מדלגים על ההעלאה."); return; }
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    folder = (await rl.question("הדביקו את הנתיב של התיקייה עם קובצי הוידאו (אפשר לגרור אותה לחלון): ")).trim().replace(/^["']|["']$/g, "");
    rl.close();
  }
  try { if (!(await stat(folder)).isDirectory()) throw 0; } catch { throw new Stop(`התיקייה לא נמצאה: ${folder}`); }
  if (folder !== settings.videosFolder) await writeJSON("settings.json", { ...settings, videosFolder: folder });

  // התאמות ידניות: file-map.csv (שם קובץ,מזהה שיעור ישן)
  const manual = {};
  try { for (const line of (await readFile(P("file-map.csv"), "utf8")).split(/\r?\n/)) { const [f, id] = line.split(",").map((x) => x.trim().replace(/^"|"$/g, "")); if (f && id) manual[f.toLowerCase()] = id; } } catch {}

  const files = (await walk(folder)).sort();
  log(`נמצאו ${files.length} קובצי וידאו בתיקייה.`);
  const taken = new Set(doneOld);
  const plan = [];
  for (const f of files) {
    const name = path.basename(f);
    if (state.files[f] && state.files[f].videoId) continue; // כבר הועלה
    let entry = manual[name.toLowerCase()] && list.lessons.find((l) => l.id === manual[name.toLowerCase()]);
    let how = "file-map.csv";
    if (!entry) {
      const m = matchFile(name, list.lessons, { taken });
      // התאמה לפי תאריך בלבד, בקובץ שהשם שלו לא מצביע על הרב (בתיקייה יכולים להיות גם שיעורים של רבנים אחרים): לא מעלים אוטומטית
      const prefixes = (settings.namePrefixes || ["jh"]).map((x) => x.toLowerCase());
      if (m && m.entry && /^תאריך/.test(m.how) && !prefixes.some((p) => name.toLowerCase().startsWith(p))) {
        rows.push([f, "", m.entry.id, m.entry.title, `התאמה לפי תאריך בלבד, ושם הקובץ לא מתחיל ב-${prefixes.join(" / ")}. לא הועלה (אפשר לקבוע ב-file-map.csv)`]);
        continue;
      }
      if (m && m.entry) { entry = m.entry; how = m.how; }
      else { rows.push([f, "", "", "", m && m.ambiguous ? "לא חד-משמעי, כמה שיעורים מתאימים (אפשר לקבוע ב-file-map.csv)" : "לא נמצא שיעור מתאים לקובץ (אפשר לקבוע ב-file-map.csv)"]); continue; }
    }
    if (taken.has(entry.id)) { rows.push([f, "", entry.id, entry.title, "השיעור כבר הועלה או הותאם לקובץ אחר"]); continue; }
    taken.add(entry.id);
    plan.push({ f, entry, how });
  }
  plan.sort((a, b) => a.entry.date.localeCompare(b.entry.date));
  log(`${plan.length} קבצים מותאמים לשיעורים וממתינים להעלאה.`);
  await fetchOldMeta(plan.map((p) => p.entry.id));

  let n = 0;
  for (const { f, entry, how } of plan) {
    const det = detailsOf(entry);
    if (DRY) { rows.push([f, "", entry.id, det.title, `יועלה (${how}); סדרות: ${entry.playlists.join(" | ") || "אין"}`]); continue; }
    if (LIMIT && n >= LIMIT) { rows.push([f, "", entry.id, det.title, "ממתין (הגעת למגבלת --limit)"]); continue; }
    const size = (await stat(f)).size;
    let sess = state.sessions[entry.id];
    if (sess && (sess.file !== f || sess.size !== size)) sess = null;
    if (!sess) {
      if (state.quota.used + UPLOAD_COST + 50 * (entry.playlists.length + 1) > DAILY_QUOTA) throw new Stop("הגענו למכסה היומית של יוטיוב. מריצים שוב מחר (המכסה מתאפסת בלילה שעון ארה\"ב, בערך 10:00 בבוקר בישראל), וממשיכים מאותו מקום.");
      const meta = {
        snippet: { title: det.title, description: det.description, tags: det.tags, categoryId: "27", defaultLanguage: "he" },
        status: { privacyStatus: settings.privacy || "public", selfDeclaredMadeForKids: false },
        ...(entry.date ? { recordingDetails: { recordingDate: entry.date + "T00:00:00Z" } } : {}),
      };
      sess = { file: f, size, url: await startSession(meta, size, MIME[path.extname(f).toLowerCase()] || "video/*") };
      state.sessions[entry.id] = sess;
      await save();
    }
    log(`מעלה: ${det.title}`);
    let video = await sendFile(sess.url, f, size, path.basename(f).slice(0, 40));
    if (video.gone) { delete state.sessions[entry.id]; await save(); log("  ההעלאה הקודמת פגה, תתחיל מחדש בריצה הבאה."); continue; }
    delete state.sessions[entry.id];
    state.files[f] = { videoId: video.id, oldId: entry.id };
    const rec = (state.done[video.id] = { oldId: entry.id, details: true, playlists: [], finished: false });
    await save();
    n++;
    count(1);
    log(`✓ הועלה: ${det.title}`);
    await ensurePlaylists(video.id, entry, rec, ctx);
    rec.finished = true;
    await save();
    rows.push([f, det.title, entry.id, det.title, `הועלה (${how})`]);
  }
}

// ---------- הרצה ----------
const keepGoing = args.has("--keep-going");
try {
  const list = await readJSON("lessons-list.json", null);
  if (!list) throw new Stop("חסר lessons-list.json (מריצים: node build-list.mjs).");
  while (true) {
    const { quotaStop } = await run(list);
    if (!(keepGoing && quotaStop && !DRY)) break;
    const day = state.quota.day;
    log("ממתינים למחר (המכסה מתאפסת בלילה שעון ארה\"ב). אפשר להשאיר את החלון פתוח.");
    while (ptDay() === day) await sleep(60000);
    state.quota = { day: ptDay(), used: 0 };
    await save();
  }
} catch (e) {
  await save().catch(() => {});
  console.error("\n" + (e instanceof Stop ? e.message : "שגיאה: " + e.message));
  process.exitCode = 1;
}
