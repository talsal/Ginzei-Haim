#!/usr/bin/env node
// יוצר את lessons-list.json (רשימת שיעורי הערוץ הישן עם הסדרות שלהם) מנתוני האתר:
//   node tools/youtube-upload/build-list.mjs
// נריץ מחדש כשיש שיעורים חדשים בערוץ הישן שצריך להעביר. שיעור מהערוץ החדש (ch) לא נכלל, ושיעור שכבר ברשימה נשמר.
import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import vm from "node:vm";
import { datesIn, placeCodeOf, stemOf } from "./match.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "../..");
const load = async (f, key) => {
  const sb = { window: {} };
  vm.runInNewContext(await readFile(path.join(ROOT, f), "utf8"), sb);
  return sb.window[key];
};
const D = await load("data/lessons.js", "LESSONS_DATA");
let M = { files: {} };
try { M = await load("data/media.js", "MEDIA_DATA"); } catch {}

const fmt = (d) => d.split("-").reverse().join(".");
const plOf = {};
for (const p of D.playlists) for (const id of p.videoIds) (plOf[id] ||= []).push(p.name);

const lessons = [];
for (const [id, v] of Object.entries(D.videos)) {
  if (v.ch || v.live) continue;
  const audio = (M.files[id] && M.files[id].a) || "";
  const series = (plOf[id] || []).filter(Boolean);
  const stem = audio ? stemOf(audio) : "";
  const ad = stem ? datesIn(stem) : [];
  const lines = [v.title, ""];
  if (series[0]) lines.push(`סדרה: ${series[0]}`);
  if (v.published) lines.push(`תאריך השיעור: ${fmt(v.published)}`);
  lines.push("", `שיעורי הרב יואל חקון, כל השיעורים עם קבצי שמע ודפי מקורות: ${D.siteUrl || "https://ginzei-haim.org"}`);
  lessons.push({
    id,
    title: v.title.replace(/[<>]/g, "").slice(0, 100),
    description: lines.join("\n").replace(/[<>]/g, ""),
    date: v.published || "",
    duration: v.duration || "",
    playlists: series,
    audio,
    audioDate: ad[0] || "",
    audioCode: audio ? placeCodeOf(audio) : "",
  });
}
// שיעור שכבר הוחלף בערוץ החדש נעלם מנתוני האתר, אבל נשאר ברשימה הקיימת (כדי שהתאמות המשך לא יאבדו)
try {
  const prev = JSON.parse(await readFile(path.join(HERE, "lessons-list.json"), "utf8"));
  const have = new Set(lessons.map((l) => l.id));
  for (const l of prev.lessons) if (!have.has(l.id)) lessons.push(l);
} catch {}
lessons.sort((a, b) => a.date.localeCompare(b.date) || a.title.localeCompare(b.title));
const playlists = D.playlists.filter((p) => p.id !== "more").map((p) => ({ name: p.name, description: p.description || "" }));
await writeFile(path.join(HERE, "lessons-list.json"), JSON.stringify({ generatedAt: new Date().toISOString(), playlists, lessons }, null, 1) + "\n");
console.log(`נכתב lessons-list.json: ${lessons.length} שיעורים, ${lessons.filter((l) => l.audio).length} עם שם קובץ שמע (לעזרה בהתאמה)`);
