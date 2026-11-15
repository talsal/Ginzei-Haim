// התאמה אוטומטית של קבצי שמע ו-PDF שהרב מעלה ל-R2 לשיעורים מיוטיוב שעוד אין להם קבצים.
//
// הכלל (כמו שהרב כבר נותן שמות לקבצים):
//   JH-26-11-11 Tfila - Kuz - Sidur - BVG.mp3
//   ^^ תאריך השיעור (שנה-חודש-יום)            ^^^ קוד המקום בסוף השם (BVG = בית וגן, ראו placeCodes ב-config.json)
//
// שמע: קובץ mp3 שהתאריך שלו הוא יום פרסום השיעור ביוטיוב או עד 3 ימים לפני (פרמיירה למחרת),
//       ושקוד המקום שלו תואם את המקום של הפלייליסט. מקשרים רק כשההתאמה חד-משמעית
//       (לשיעור יש קובץ אחד הכי קרוב, ולקובץ יש שיעור אחד הכי קרוב). אחרת השיעור נשאר ברשימת "לא הותאמו".
// PDF: דף המקורות האחרון שבאותה תיקייה של קובץ השמע, שהתאריך בשמו הוא עד יום השיעור
//       (הרב ממשיך באותו דף כמה שיעורים, ומעלה דף חדש כשמתחילים נושא). אם אין כזה, ממשיכים את הדף של השיעור הקודם בסדרה.
//       בבדיקה על השיעורים הקיימים: השמע נכון ב-100% מההתאמות, ה-PDF בכ-86%. לכן חשוב שיהיה תיקון ידני.
// תיקון ידני תמיד גובר: data/media-overrides.json.

import { readFileSync } from "node:fs";
import vm from "node:vm";

const DAY = 864e5;
const MAX_DAYS_BEFORE = 3;
const REPORT_DAYS = 60;

const baseOf = (k) => k.split("/").pop();
const dirOf = (k) => k.split("/").slice(0, -1).join("/");

// תאריך מתוך שם הקובץ: JH-26-11-11, 26-11-11, 2026-11-11
export function fileDate(key) {
  const m = baseOf(key).match(/(?:^|[^\d])((?:20)?\d\d)-(\d\d)-(\d\d)(?![\d])/);
  if (!m) return null;
  const y = m[1].length === 2 ? "20" + m[1] : m[1];
  const t = Date.parse(`${y}-${m[2]}-${m[3]}`);
  return Number.isNaN(t) ? null : t;
}

// קוד המקום: המילה האחרונה בשם הקובץ (BVG, MH, Y, HH, YN...)
export function fileCode(key) {
  const name = baseOf(key).replace(/\.[^.]+$/, "");
  const last = name.split(/[\s\-_]+/).filter(Boolean).pop() || "";
  return last.toUpperCase();
}

export function autoMatch({ files, have, lessonsPath, config, skip = new Set(), reserved = new Set() }) {
  const ctx = { window: {} };
  vm.runInNewContext(readFileSync(lessonsPath, "utf8"), ctx);
  const { videos = {}, playlists = [] } = ctx.window.LESSONS_DATA;

  const codes = {};
  for (const [code, place] of Object.entries(config.placeCodes || {})) codes[code.toUpperCase()] = place;
  const placeOf = {};
  const seriesOf = {};
  for (const pl of playlists) for (const id of pl.videoIds) {
    if (!placeOf[id]) placeOf[id] = pl.place;
    if (!seriesOf[id]) seriesOf[id] = pl;
  }

  const used = new Set(reserved);
  for (const f of Object.values(files)) { if (f.a) used.add(f.a); }
  const mp3s = have.filter((k) => /\.mp3$/i.test(k) && !used.has(k) && fileDate(k) !== null);
  const pdfs = have.filter((k) => /\.pdf$/i.test(k));

  const lessons = Object.keys(videos).filter((id) => !skip.has(id) && !(files[id] && files[id].a) && videos[id].published);
  const pub = (id) => Date.parse(videos[id].published.slice(0, 10));

  // כל הזוגות האפשריים, עם המרחק בימים
  const pairs = [];
  for (const id of lessons) {
    const place = placeOf[id];
    for (const k of mp3s) {
      const d = Math.round((pub(id) - fileDate(k)) / DAY);
      if (d < 0 || d > MAX_DAYS_BEFORE) continue;
      const codePlace = codes[fileCode(k)];
      if (codePlace ? codePlace !== place : !!place && place !== "כללי") continue; // קוד לא מוכר: רק לשיעורים כלליים
      pairs.push({ id, k, d });
    }
  }
  const best = (list) => { const m = Math.min(...list.map((p) => p.d)); return list.filter((p) => p.d === m); };
  const byId = new Map(), byKey = new Map();
  for (const p of pairs) {
    (byId.get(p.id) || byId.set(p.id, []).get(p.id)).push(p);
    (byKey.get(p.k) || byKey.set(p.k, []).get(p.k)).push(p);
  }

  const linked = [];
  for (const [id, list] of byId) {
    const b = best(list);
    if (b.length !== 1) continue;
    const kb = best(byKey.get(b[0].k));
    if (kb.length !== 1 || kb[0].id !== id) continue;
    files[id] = { ...(files[id] || {}), a: b[0].k };
    linked.push(id);
  }

  // PDF לשיעורים שקושרו עכשיו (מהישן לחדש, כדי שהמשך הסדרה יעבור הלאה)
  linked.sort((a, b) => videos[a].published.localeCompare(videos[b].published));
  for (const id of linked) {
    if (files[id].p && files[id].p.length) continue;
    const a = files[id].a;
    const day = fileDate(a);
    // דף המקורות האחרון באותה תיקייה שהתאריך שלו עד יום השיעור
    const latest = pdfs
      .filter((k) => dirOf(k) === dirOf(a) && fileDate(k) !== null && fileDate(k) <= day)
      .sort((x, y) => fileDate(y) - fileDate(x) || x.localeCompare(y))[0];
    let p = latest ? [latest] : [];
    if (!p.length) {
      const pl = seriesOf[id];
      const prev = pl && pl.videoIds
        .filter((v) => v !== id && videos[v] && videos[v].published < videos[id].published && files[v] && files[v].p)
        .sort((x, y) => videos[y].published.localeCompare(videos[x].published))[0];
      if (prev) p = files[prev].p;
    }
    if (p.length) files[id].p = [...p];
  }

  const recent = Date.now() - REPORT_DAYS * DAY;
  const line = (id) => ({ id, date: videos[id].published, title: videos[id].title, place: placeOf[id] || "" });
  return {
    _note: "נוצר אוטומטית. linked = שיעורים שקיבלו קבצים לפי שם הקובץ. unmatched = שיעורים מ-60 הימים האחרונים שעוד אין להם שמע.",
    linked: linked.map((id) => ({ ...line(id), a: files[id].a, p: files[id].p || [] })),
    unmatched: lessons
      .filter((id) => !linked.includes(id) && pub(id) >= recent)
      .sort((a, b) => videos[b].published.localeCompare(videos[a].published))
      .map((id) => ({ ...line(id), candidates: (byId.get(id) || []).map((p) => p.k) })),
  };
}
