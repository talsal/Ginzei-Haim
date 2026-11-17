// התאמת סרטון חדש (שהרב העלה לערוץ החדש) לשיעור המקורי בערוץ הישן (lessons-list.json). פונקציות טהורות, בלי תלויות.
// הכותרת של סרטון שהועלה ידנית היא בדרך כלל שם הקובץ, ולכן מתאימים לפי שם, ולפי משך הסרטון (אותו קובץ = אותו משך).
// סדר ההתאמה בשם (הראשון שמצליח, ורק אם התוצאה חד-משמעית):
//  2. שם הקובץ זהה לשם קובץ השמע של השיעור (למשל JH-26-11-11 Tfila - Kuz - BVG)
//  3. תאריך בשם הקובץ + קוד מקום (BVG, HH, MH, Y, YN)
//  4. שם הקובץ זהה (או כמעט) לכותרת השיעור
//  5. תאריך בלבד, רק אם יש שיעור אחד בלי קובץ שמע בתאריך הזה
import path from "node:path";

export const VIDEO_EXT = new Set([".mp4", ".mov", ".mkv", ".avi", ".wmv", ".m4v", ".webm", ".mpg", ".mpeg", ".flv", ".3gp", ".mts", ".m2ts"]);

export const norm = (s) =>
  String(s)
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[֑-ׇ]/g, "")
    .replace(/[״"'׳`’“”]/g, "")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();

export const stemOf = (name) => path.basename(name).replace(/\.[^.]+$/, "");

const pad = (n) => String(n).padStart(2, "0");
function valid(y, m, d) {
  if (m < 1 || m > 12 || d < 1 || d > 31) return null;
  return `${y}-${pad(m)}-${pad(d)}`;
}

// כל התאריכים האפשריים בשם (ייתכנו כמה פרשנויות), כמחרוזות YYYY-MM-DD
export function datesIn(name) {
  const s = stemOf(name);
  const out = new Set();
  let m;
  const add = (v) => v && out.add(v);
  const reA = /(?:^|\D)(20\d\d)[-._ ]?(\d\d)[-._ ]?(\d\d)(?!\d)/g; // 2026-11-11, 20261111
  while ((m = reA.exec(s))) add(valid(+m[1], +m[2], +m[3]));
  const reB = /(?:^|\D)(\d\d?)[-._ ](\d\d?)[-._ ](20\d\d)(?!\d)/g; // 11.11.2026
  while ((m = reB.exec(s))) add(valid(+m[3], +m[2], +m[1]));
  const reC = /(?:^|\D)(\d\d)[-._ ](\d\d)[-._ ](\d\d)(?!\d)/g; // 26-11-11 (שנה-חודש-יום) או 11.11.26 (יום-חודש-שנה)
  while ((m = reC.exec(s))) {
    add(valid(2000 + +m[1], +m[2], +m[3]));
    add(valid(2000 + +m[3], +m[2], +m[1]));
  }
  return [...out];
}

// קוד המקום בסוף השם: "... - BVG" או "...-YN"
export function placeCodeOf(name) {
  const m = stemOf(name).match(/[\s_-]([A-Za-z]{1,3})\s*$/);
  return m ? m[1].toUpperCase() : "";
}

const tokens = (s) => new Set(norm(s).split(" ").filter((t) => t.length > 1));
function overlap(a, b) {
  const A = tokens(a), B = tokens(b);
  let n = 0;
  for (const t of A) if (B.has(t)) n++;
  return n;
}

// entries: רשימת שיעורים (id, title, date, audio). מחזיר { entry, how } | { ambiguous:[ids] } | null
export function matchFile(fileName, entries, ctx = {}) {
  const stem = stemOf(fileName);
  const nStem = norm(stem);
  const taken = ctx.taken || new Set();
  const free = entries.filter((e) => !taken.has(e.id));
  const one = (arr, how) => (arr.length === 1 ? { entry: arr[0], how } : arr.length > 1 ? { ambiguous: arr.map((e) => e.id) } : null);

  // 2. שם קובץ השמע
  const byAudio = free.filter((e) => e.audio && norm(stemOf(e.audio)) === nStem);
  if (byAudio.length) return one(byAudio, "שם קובץ השמע");

  // 3. תאריך + קוד מקום
  const dates = new Set(datesIn(fileName));
  const code = placeCodeOf(fileName);
  if (dates.size) {
    let cand = free.filter((e) => e.audioDate && dates.has(e.audioDate));
    if (code) {
      const withCode = cand.filter((e) => e.audioCode === code);
      if (withCode.length) cand = withCode;
    }
    if (cand.length === 1) return { entry: cand[0], how: "תאריך ומקום" };
    if (cand.length > 1) {
      const scored = cand.map((e) => ({ e, s: overlap(stem, stemOf(e.audio)) })).sort((a, b) => b.s - a.s);
      if (scored[0].s > scored[1].s) return { entry: scored[0].e, how: "תאריך ומקום ושם" };
      return { ambiguous: cand.map((e) => e.id) };
    }
  }

  // 4. כותרת
  const byTitle = free.filter((e) => norm(e.title) === nStem);
  if (byTitle.length) return one(byTitle, "כותרת");
  if (nStem.length >= 14) {
    const part = free.filter((e) => norm(e.title).includes(nStem) || (norm(e.title).length >= 14 && nStem.includes(norm(e.title))));
    if (part.length === 1) return { entry: part[0], how: "כותרת חלקית" };
  }

  // 5. תאריך בלבד: שיעור יחיד בלי קובץ שמע בתאריך (כולל יום או יומיים אחרי התאריך המקורי)
  if (dates.size) {
    const cand = free.filter((e) => !e.audio && dates.has(e.date));
    if (cand.length === 1) return { entry: cand[0], how: "תאריך בלבד" };
  }
  return null;
}

export const secondsOf = (d) => (d ? String(d).split(":").reduce((a, x) => a * 60 + Number(x), 0) : 0);

// התאמה של סרטון חדש {title, seconds} לשיעור ברשימה. מחזיר { entry, how, sure } | { ambiguous:[ids] } | null
// sure=false: התאמה לפי משך בלבד, ללא אישור מהשם (מוצגת בדוח, ומיושמת רק עם --accept-duration או בלי --careful).
export function matchVideo(video, entries, taken = new Set()) {
  const free = entries.filter((e) => !taken.has(e.id));
  const byName = matchFile(video.title, free);
  if (byName && byName.entry) {
    const e = byName.entry;
    const dur = secondsOf(e.duration);
    if (!video.seconds || !dur || Math.abs(video.seconds - dur) <= 3) return { ...byName, sure: true };
    return { ambiguous: [e.id], note: "השם מתאים אבל המשך שונה" };
  }
  if (byName && byName.ambiguous) {
    // אחרי התאמת שם עמומה, המשך יכול להכריע
    const cand = free.filter((e) => byName.ambiguous.includes(e.id) && video.seconds && Math.abs(secondsOf(e.duration) - video.seconds) <= 1);
    if (cand.length === 1) return { entry: cand[0], how: "שם ומשך", sure: true };
    return byName;
  }
  if (video.seconds) {
    const diffs = free.filter((e) => e.duration).map((e) => ({ e, d: Math.abs(secondsOf(e.duration) - video.seconds) })).sort((a, b) => a.d - b.d);
    if (diffs.length && diffs[0].d <= 1) {
      if (diffs.length === 1 || diffs[1].d > 3) return { entry: diffs[0].e, how: "משך ייחודי", sure: false };
      return { ambiguous: diffs.filter((x) => x.d <= 3).map((x) => x.e.id), note: "כמה שיעורים באותו משך" };
    }
  }
  return null;
}
