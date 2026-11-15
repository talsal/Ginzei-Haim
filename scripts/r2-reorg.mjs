// סידור תיקיות ב-R2 בבטחה: רק העתקה, אף פעם לא מוחקים.
//   MODE=list  מדפיס את כל הקבצים בדלי (גודל, נתיב)
//   MODE=copy  מעתיק לפי data/r2-reorg-plan.json (prefixes: תיקייה ישנה -> חדשה, או moves: קובץ -> קובץ) ובודק שהגודל זהה.
//              DRY_RUN=1 רק מראה מה יועתק.
// אחרי ההעתקה scripts/media-import.mjs מעדיף את הנתיב החדש (ראו moves שם), כך שהאתר עובר לנתיבים החדשים.
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFile } from "node:fs/promises";

const run = promisify(execFile);
const { R2_ENDPOINT, R2_BUCKET } = process.env;
const MODE = process.env.MODE || "list";
const DRY = process.env.DRY_RUN === "1";
const aws = (...a) => run("aws", [...a, "--endpoint-url", R2_ENDPOINT, "--output", "json"], { maxBuffer: 1 << 28 });

async function listAll() {
  const have = new Map();
  let token;
  do {
    const { stdout } = await aws("s3api", "list-objects-v2", "--bucket", R2_BUCKET, ...(token ? ["--starting-token", token] : []));
    const j = stdout.trim() ? JSON.parse(stdout) : {};
    for (const o of j.Contents || []) have.set(o.Key, o.Size);
    token = j.NextToken;
  } while (token);
  return have;
}

const have = await listAll();
if (MODE === "list") {
  console.log(`${have.size} קבצים`);
  const dirs = {};
  for (const k of have.keys()) { const d = k.split("/").slice(0, -1).join("/") || "(שורש)"; dirs[d] = (dirs[d] || 0) + 1; }
  for (const d of Object.keys(dirs).sort()) console.log(`DIR\t${dirs[d]}\t${d}`);
  const pre = (process.env.PREFIXES || "").split("|").filter(Boolean);
  for (const k of [...have.keys()].sort()) if (pre.some((p) => k.startsWith(p))) console.log(`KEY\t${k}`);
  process.exit(0);
}

const plan = JSON.parse(await readFile("data/r2-reorg-plan.json", "utf8"));
const moves = { ...(plan.moves || {}) };
for (const [a, b] of Object.entries(plan.prefixes || {}))
  for (const k of have.keys()) if (k.startsWith(a) && !k.endsWith("/")) moves[k] = b + k.slice(a.length);
console.log(`${Object.keys(moves).length} קבצים בתוכנית`);
let ok = 0, skip = 0, fail = 0;
for (const [from, to] of Object.entries(moves)) {
  if (!have.has(from)) { console.log(`✗ לא קיים: ${from}`); fail++; continue; }
  if (have.get(to) === have.get(from)) { skip++; continue; }
  if (DRY) { console.log(`→ ${from}  =>  ${to}`); ok++; continue; }
  try {
    await aws("s3api", "copy-object", "--bucket", R2_BUCKET, "--copy-source", `${R2_BUCKET}/${from}`, "--key", to);
    const { stdout } = await aws("s3api", "head-object", "--bucket", R2_BUCKET, "--key", to);
    if (JSON.parse(stdout).ContentLength !== have.get(from)) throw new Error("גודל לא תואם");
    console.log(`✓ ${to}`); ok++;
  } catch (e) { console.log(`✗ ${from}: ${e.message}`); fail++; }
}
console.log(`${DRY ? "בדיקה: יועתקו" : "הועתקו"} ${ok}, כבר קיימים ${skip}, נכשלו ${fail}. שום קובץ לא נמחק.`);
if (fail) process.exitCode = 1;
