#!/usr/bin/env python3
"""Nightly migration batch: old channel (@hachiem.vehashalom) -> new channel (@ginzei-haim).

Steps (each logged to <WORK>/nightly-YYYY-MM-DD.log):
  1. pick the next BATCH lessons that are not on the new channel yet AND whose series has an
     EXISTING rabbi playlist ("הרב יואל חקון - ..."). Lessons without one are skipped and listed.
  2. download them with yt-dlp (1080p, no cookies). When YouTube answers "not a bot", wait 45 min and retry.
  3. dry-run, then upload with ginzei-youtube.mjs (--no-fix), as private.
  4. wait until YouTube finished processing, wait 20 more minutes, then set them public.
  5. dispatch a FULL site sync (sync.yml, quick=false) so the site picks up the new lessons.

Usage:  nightly-batch.py [--plan-only]
Env:    GINZEI_WORK  folder with client_secret.json, token.json, state.json, settings.json, lessons-list.json
                     (default ~/dev/pilot2-tool). The uploader .mjs files are copied there from this folder.
        BATCH        lessons per night (default 18)
        DEADLINE     stop downloading after this hour (default 9, local time)
"""
import datetime, json, os, re, shutil, subprocess, sys, time, unicodedata, urllib.parse, urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
WORK = os.path.expanduser(os.environ.get("GINZEI_WORK", "~/dev/pilot2-tool"))
BATCH = int(os.environ.get("BATCH", "18"))
DEADLINE = int(os.environ.get("DEADLINE", "9"))
REPO = "talsal/ginzei-haim"
PLAN_ONLY = "--plan-only" in sys.argv
TODAY = datetime.date.today().isoformat()
OUT = os.path.expanduser(f"~/dev/ginzei-batch-{TODAY}")
RABBI = "הרב יואל חקון"
NO_SERIES = {"שיעורים נוספים"}

os.chdir(WORK)
LOG = open(os.path.join(WORK, f"nightly-{TODAY}.log"), "a", buffering=1)
def log(*a):
    line = " ".join([datetime.datetime.now().strftime("%H:%M:%S"), *map(str, a)])
    print(line, file=LOG, flush=True); print(line, flush=True)

# ---------- YouTube API (OAuth token of the uploader, same as ginzei-youtube.mjs) ----------
_tok = {"v": None, "t": 0}
def token():
    if _tok["v"] and time.time() - _tok["t"] < 1800: return _tok["v"]
    c = json.load(open("client_secret.json"))["installed"]; t = json.load(open("token.json"))
    d = urllib.parse.urlencode({"client_id": c["client_id"], "client_secret": c["client_secret"], "refresh_token": t["refresh_token"], "grant_type": "refresh_token"}).encode()
    _tok.update(v=json.load(urllib.request.urlopen(urllib.request.Request("https://oauth2.googleapis.com/token", data=d)))["access_token"], t=time.time())
    return _tok["v"]
def call(method, ep, q=None, body=None):
    u = f"https://www.googleapis.com/youtube/v3/{ep}?" + urllib.parse.urlencode(q or {})
    r = urllib.request.Request(u, data=json.dumps(body).encode() if body is not None else None, method=method,
                               headers={"Authorization": "Bearer " + token(), "Content-Type": "application/json"})
    return json.load(urllib.request.urlopen(r))
def list_all(ep, q):
    out, page = [], None
    while True:
        r = call("GET", ep, {**q, "maxResults": 50, **({"pageToken": page} if page else {})})
        out += r.get("items", []); page = r.get("nextPageToken")
        if not page: return out

def norm(s):
    s = unicodedata.normalize("NFC", s or "").replace("״", '"').replace("׳", "'")
    return re.sub(r"[\s.]+$", "", re.sub(r"\s+", " ", s)).strip()
def strip_rabbi(s):
    return re.sub(r"^הרב יואל חקון\s*-\s*", "", norm(s))

def new_channel_videos():
    up = call("GET", "channels", {"part": "contentDetails", "mine": "true"})["items"][0]["contentDetails"]["relatedPlaylists"]["uploads"]
    return [i["contentDetails"]["videoId"] for i in list_all("playlistItems", {"part": "contentDetails", "playlistId": up})]
def video_info(ids, part):
    out = []
    for i in range(0, len(ids), 50): out += call("GET", "videos", {"part": part, "id": ",".join(ids[i:i + 50])})["items"]
    return out

# ---------- 1. pick ----------
def pick():
    lst = json.load(open("lessons-list.json")); state = json.load(open("state.json"))
    settings = json.load(open("settings.json")) if os.path.exists("settings.json") else {}
    pmap = settings.get("playlistMap", {})
    rabbi = {}
    titles_by_id = {}
    for p in list_all("playlists", {"part": "snippet", "mine": "true"}):
        titles_by_id[p["id"]] = p["snippet"]["title"]
        if norm(p["snippet"]["title"]).startswith(RABBI): rabbi[strip_rabbi(p["snippet"]["title"])] = p["id"]
    by_title = {norm(t): i for i, t in titles_by_id.items()}
    def resolve(name):
        m = pmap.get(name)
        if m: return m if m in titles_by_id else by_title.get(norm(m))
        return rabbi.get(strip_rabbi(name))
    done_old = {d.get("oldId") for d in state.get("done", {}).values()} | {d.get("oldId") for d in state.get("files", {}).values()}
    have_titles = {norm(v["snippet"]["title"]) for v in video_info(new_channel_videos(), "snippet")}
    chosen, no_playlist = [], {}
    for l in sorted(lst["lessons"], key=lambda l: (l.get("date") or "", l["title"])):
        if l["id"] in done_old or norm(l["title"]) in have_titles: continue
        series = [p for p in l.get("playlists", []) if p not in NO_SERIES]
        if not series:
            no_playlist.setdefault("(בלי סדרה)", 0); no_playlist["(בלי סדרה)"] += 1; continue
        missing = [p for p in series if not resolve(p)]
        if missing:
            for p in missing: no_playlist[p] = no_playlist.get(p, 0) + 1
            continue
        if len(chosen) < BATCH: chosen.append(l)
    log("picked", len(chosen), "lessons")
    for l in chosen: log("  ", l["id"], l.get("date"), l["title"][:90])
    if no_playlist:
        log("SKIPPED (no existing rabbi playlist, nothing created):")
        for p, n in sorted(no_playlist.items(), key=lambda x: -x[1]): log(f"   {n:4d}  {p}")
    return chosen

# ---------- 2. download ----------
def fname(l): return l["title"].replace("/", "-").strip()
def have(l): return os.path.exists(os.path.join(OUT, fname(l) + ".mp4"))
def download(items):
    os.makedirs(OUT, exist_ok=True)
    for rnd in range(12):
        todo = [l for l in items if not have(l)]
        log("download round", rnd, "todo", len(todo))
        if not todo: return
        if datetime.datetime.now().hour >= DEADLINE and datetime.datetime.now().hour < 20:
            log("download deadline reached, continuing with what we have"); return
        blocked = False
        for l in todo:
            r = subprocess.run(["yt-dlp", "--no-update", "-f", "bv*[height<=1080][ext=mp4]+ba[ext=m4a]/bv*[height<=1080]+ba/b[height<=1080]",
                                "--merge-output-format", "mp4", "--limit-rate", "6M", "--retries", "3", "--sleep-requests", "3",
                                "-o", os.path.join(OUT, fname(l) + ".%(ext)s"), "--", f"https://www.youtube.com/watch?v={l['id']}"],
                               capture_output=True, text=True)
            ok = r.returncode == 0 and have(l)
            log("  dl", l["id"], "ok" if ok else "FAIL " + (r.stderr or "")[-160:].replace("\n", " "))
            if not ok and re.search(r"not a bot|Sign in", r.stderr or ""):
                blocked = True; break
            time.sleep(120)
        if blocked or [l for l in items if not have(l)]:
            log("blocked by YouTube (no cookies used); waiting 45 min"); time.sleep(45 * 60)

# ---------- 3-5 ----------
def run_tool(*a):
    r = subprocess.run(["node", "ginzei-youtube.mjs", "--no-fix", *a], capture_output=True, text=True)
    out = r.stdout + r.stderr
    for line in out.splitlines():
        if "✗✗" in line or "לא הועלה" in line: log("  TOOL:", line)
    return r.returncode, out

def main():
    for f in ("ginzei-youtube.mjs", "match.mjs"):
        if os.path.exists(f) and not os.path.exists(f + ".bak-before-nightly"): shutil.copy(f, f + ".bak-before-nightly")
        shutil.copy(os.path.join(HERE, f), f)
    log("=== nightly batch", TODAY, "work", WORK)
    items = pick()
    if PLAN_ONLY or not items: log("plan only" if PLAN_ONLY else "nothing to do"); return
    download(items)
    got = [l for l in items if have(l)]
    log("downloaded", len(got), "/", len(items))
    if not got: raise SystemExit("no files downloaded")
    st = json.load(open("settings.json")) if os.path.exists("settings.json") else {}
    st["videosFolder"] = OUT; st["privacy"] = "private"; json.dump(st, open("settings.json", "w"), ensure_ascii=False)
    code, out = run_tool("--dry-run", "--limit", "100")
    m = re.search(r"(\d+) קבצים מותאמים", out); matched = int(m.group(1)) if m else 0
    log("dry-run matched", matched, "exit", code)
    if matched < len(got) - 1: raise SystemExit("matching too low: " + out[-400:])
    before = set(new_channel_videos())
    for attempt in range(3):
        code, out = run_tool("--limit", "100")
        up = len(re.findall(r"✓ הועלה", out)); log("upload run", attempt, "uploaded", up, "exit", code)
        if up == 0 or "0 קבצים מותאמים" in out: break
    new = sorted(set(new_channel_videos()) - before); log("new videos", len(new), new)
    json.dump(new, open(f"nightly-{TODAY}-new.json", "w"))
    if new:
        t0 = time.time()
        while time.time() - t0 < 4 * 3600:
            v = video_info(new, "status")
            n = sum(x["status"]["uploadStatus"] == "processed" for x in v); log("processed", n, "/", len(new))
            if n == len(new): break
            time.sleep(120)
        time.sleep(20 * 60)  # copyright checks
        for x in video_info(new, "snippet,status"):
            s = x["status"]
            if s.get("uploadStatus") != "processed": log("NOT published (not processed)", x["id"]); continue
            call("PUT", "videos", {"part": "status"}, {"id": x["id"], "status": {"privacyStatus": "public", "selfDeclaredMadeForKids": False,
                 "embeddable": s.get("embeddable", True), "publicStatsViewable": s.get("publicStatsViewable", True), "license": s.get("license", "youtube")}})
            log("public", x["id"], x["snippet"]["title"][:70])

def full_sync():
    r = subprocess.run(["gh", "workflow", "run", "sync.yml", "-R", REPO, "--ref", "main", "-f", "quick=false"], capture_output=True, text=True)
    log("full site sync dispatched" if r.returncode == 0 else "SYNC DISPATCH FAILED: " + (r.stderr or "")[-300:])

if __name__ == "__main__":
    lock = os.path.join(WORK, "nightly.lock")
    if os.path.exists(lock) and time.time() - os.path.getmtime(lock) < 20 * 3600:
        log("another batch is running (nightly.lock), exiting"); sys.exit(0)
    open(lock, "w").write(str(os.getpid()))
    try:
        main()
    except SystemExit as e:
        log("STOP", e)
    except Exception as e:
        log("ERROR", repr(e))
    finally:
        if not PLAN_ONLY: full_sync()  # always last, so anything published gets picked up
        os.remove(lock)
        log("DONE")
