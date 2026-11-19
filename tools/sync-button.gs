/**
 * כפתור הסנכרון של הרב (Google Apps Script)
 *
 * מה זה עושה:
 *  1. doGet: קישור שהרב שומר במועדפים / במסך הבית בטלפון. פותח את דף הניהול (קובץ admin.html בפרויקט):
 *     רשימת השיעורים עם קבצי השמע וה-PDF שלהם, שינוי ידני של הקבצים, וכפתור "סנכרון עכשיו".
 *  2. quickCheck: רץ אוטומטית כל 10 דקות (טריגר זמן) ומפעיל "בדיקה מהירה",
 *     כי התזמון של GitHub עצמו מתעכב ולפעמים רץ רק כמה פעמים ביום.
 *
 * הטוקן של GitHub שמור ב-Script Properties (לא בקוד ולא באתר הציבורי), ולכן אף אחד לא רואה אותו.
 * הוראות התקנה: ראו README.md, בסעיף "כפתור סנכרון לרב".
 *
 * Script Properties שצריך להגדיר:
 *   GITHUB_TOKEN  טוקן fine-grained לריפו Ginzei-Haim בלבד, עם הרשאות Actions: Read and write
 *                 ו-Contents: Read and write (דף הניהול שומר את השינויים בקובץ data/media-overrides.json)
 *   SYNC_KEY      סיסמה קצרה שמופיעה בקישור של הרב (?key=...), כדי שזרים לא יפעילו סנכרון
 */

var REPO = 'talsal/Ginzei-Haim';
var WORKFLOW = 'sync.yml';
var SITE_URL = 'https://ginzei-haim.org/';

function dispatch_(quick) {
  var token = PropertiesService.getScriptProperties().getProperty('GITHUB_TOKEN');
  if (!token) throw new Error('חסר GITHUB_TOKEN ב-Script Properties');
  var res = UrlFetchApp.fetch(
    'https://api.github.com/repos/' + REPO + '/actions/workflows/' + WORKFLOW + '/dispatches',
    {
      method: 'post',
      contentType: 'application/json',
      headers: {
        Authorization: 'Bearer ' + token,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28'
      },
      payload: JSON.stringify({ ref: 'main', inputs: { quick: quick } }),
      muteHttpExceptions: true
    }
  );
  return res.getResponseCode(); // 204 = הצליח
}

// הקישור של הרב: דף הניהול (רשימת שיעורים, שיוך שמע ו-PDF, וכפתור סנכרון)
function doGet(e) {
  var key = PropertiesService.getScriptProperties().getProperty('SYNC_KEY');
  if (!key || !e || !e.parameter || e.parameter.key !== key) {
    return page_('הקישור לא תקין', 'חסרה או שגויה הסיסמה בקישור. כדאי לבקש את הקישור המלא מחדש.', false);
  }
  var t = HtmlService.createTemplateFromFile('admin');
  t.key = key;
  return t.evaluate()
    .setTitle('ניהול קבצים - גנזי חיים')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1');
}

// טריגר זמן: כל 10 דקות
function quickCheck() {
  dispatch_(true);
}

// להריץ פעם אחת מהעורך כדי ליצור את הטריגר של כל 10 דקות
function installTrigger() {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === 'quickCheck') ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('quickCheck').timeBased().everyMinutes(10).create();
}

function page_(title, text, ok) {
  var html =
    '<!doctype html><html lang="he" dir="rtl"><head><meta charset="utf-8">' +
    '<meta name="viewport" content="width=device-width,initial-scale=1">' +
    '<style>body{font-family:system-ui,Arial,sans-serif;background:#faf7f0;color:#2b2b2b;' +
    'display:flex;min-height:90vh;align-items:center;justify-content:center;margin:0;padding:16px;text-align:center}' +
    '.c{max-width:420px}h1{font-size:28px;color:' + (ok ? '#2e6b3a' : '#a33') + '}p{font-size:20px;line-height:1.5}' +
    'a{display:inline-block;margin-top:16px;font-size:20px;color:#7a5a1f}</style></head><body><div class="c">' +
    '<h1>' + title + '</h1><p>' + text + '</p>' +
    '<a href="' + SITE_URL + '" target="_top">לאתר גנזי חיים</a></div></body></html>';
  return HtmlService.createHtmlOutput(html)
    .setTitle('סנכרון גנזי חיים')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1');
}

// ======================= דף הניהול =======================

var OVERRIDES = 'data/media-overrides.json';

function checkKey_(key) {
  var k = PropertiesService.getScriptProperties().getProperty('SYNC_KEY');
  if (!k || key !== k) throw new Error('אין הרשאה');
}

function gh_(method, path, payload, accept) {
  var token = PropertiesService.getScriptProperties().getProperty('GITHUB_TOKEN');
  var opt = {
    method: method,
    headers: {
      Authorization: 'Bearer ' + token,
      Accept: accept || 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28'
    },
    muteHttpExceptions: true
  };
  if (payload) { opt.contentType = 'application/json'; opt.payload = JSON.stringify(payload); }
  return UrlFetchApp.fetch('https://api.github.com/repos/' + REPO + '/' + path, opt);
}

// קובץ מהריפו (ענף main) כטקסט
function raw_(path) {
  var r = gh_('get', 'contents/' + path + '?ref=main', null, 'application/vnd.github.raw+json');
  if (r.getResponseCode() === 404) return '';
  if (r.getResponseCode() !== 200) throw new Error('קריאת ' + path + ' נכשלה (' + r.getResponseCode() + ')');
  return r.getContentText('UTF-8');
}

function windowVar_(text, name) {
  var m = text.match(new RegExp('window\\.' + name + '\\s*=\\s*([\\s\\S]*?);?\\s*$'));
  return m ? JSON.parse(m[1]) : {};
}

function readOverrides_() {
  var r = gh_('get', 'contents/' + OVERRIDES + '?ref=main');
  if (r.getResponseCode() === 404) return { data: {}, sha: null };
  if (r.getResponseCode() !== 200) throw new Error('קריאת התיקונים נכשלה (' + r.getResponseCode() + ')');
  var j = JSON.parse(r.getContentText());
  var text = Utilities.newBlob(Utilities.base64Decode(j.content)).getDataAsString('UTF-8');
  return { data: JSON.parse(text || '{}'), sha: j.sha };
}

// כל מה שהדף צריך: שיעורים, הקבצים שלהם, ורשימת הקבצים ב-R2
function adminData(key) {
  checkKey_(key);
  var L = windowVar_(raw_('data/lessons.js'), 'LESSONS_DATA');
  var M = windowVar_(raw_('data/media.js'), 'MEDIA_DATA');
  var report = JSON.parse(raw_('data/media-report.json') || '{"linked":[]}');
  var r2 = JSON.parse(raw_('data/r2-files.json') || '[]');
  var ovr = readOverrides_().data;
  var auto = {};
  (report.linked || []).forEach(function (l) { auto[l.id] = 1; });
  var files = M.files || {};
  var extra = M.extra || { videos: {}, playlists: [] };
  var out = [], seen = {};
  function add(videos, playlists) {
    (playlists || []).forEach(function (pl) {
      (pl.videoIds || []).forEach(function (id) {
        var v = videos[id];
        if (!v || seen[id]) return;
        seen[id] = 1;
        var f = files[id] || {};
        out.push({
          id: id, t: v.title, d: ((ovr[id] && ovr[id].date) || v.date || v.published || '').slice(0, 10),
          od: (ovr[id] && ovr[id].date) || '', ol: (ovr[id] && ovr[id].link) || '', pl: pl.place || '', s: pl.topic || pl.name || '',
          a: f.a || '', p: f.p || [], ao: !!v.audioOnly,
          src: ovr[id] ? 'manual' : auto[id] ? 'auto' : ''
        });
      });
    });
  }
  add(L.videos || {}, L.playlists || []);
  add(extra.videos || {}, extra.playlists || []);
  out.sort(function (x, y) { return x.d < y.d ? 1 : x.d > y.d ? -1 : 0; });
  return JSON.stringify({ base: M.base || '', lessons: out, files: r2, overrides: ovr });
}

// מזהה סרטון ביוטיוב מתוך קישור (watch?v=, youtu.be/, shorts/, embed/) או מזהה חשוף
function videoId_(s) {
  s = String(s || '').trim();
  if (/^[A-Za-z0-9_-]{11}$/.test(s)) return s;
  var m = s.match(/(?:[?&]v=|youtu\.be\/|\/shorts\/|\/embed\/|\/live\/)([A-Za-z0-9_-]{11})(?![A-Za-z0-9_-])/);
  if (!m) throw new Error('קישור יוטיוב לא תקין');
  return m[1];
}

// שמירת תיקון ידני לשיעור. value = אובייקט עם רק השדות שהשתנו: a (קובץ שמע או null), p (רשימת PDF),
// date (YYYY-MM-DD, או '' להסרה), link (קישור/מזהה יוטיוב, או '' להסרה). שדות שלא נשלחו נשארים כמו שהיו.
// value = null: חזרה לאוטומטי לגמרי.
function adminSave(key, id, value, title) {
  checkKey_(key);
  if (!/^[A-Za-z0-9_-]{1,40}$/.test(id)) throw new Error('מזהה שיעור לא תקין');
  for (var attempt = 0; attempt < 3; attempt++) {
    var cur = readOverrides_();
    var data = cur.data || {};
    if (value) {
      var v = data[id] || {};
      if ('a' in value) v.a = value.a ? String(value.a) : null;
      if ('p' in value) v.p = (value.p || []).map(String);
      if ('date' in value) {
        if (value.date) {
          if (!/^\d{4}-\d\d-\d\d$/.test(value.date) || isNaN(Date.parse(value.date))) throw new Error('תאריך לא תקין');
          v.date = value.date;
        } else delete v.date;
      }
      if ('link' in value) {
        if (value.link) v.link = videoId_(value.link); else delete v.link;
      }
      if (title) v._title = String(title).slice(0, 120);
      if ('a' in v || 'p' in v || v.date || v.link) data[id] = v; else delete data[id];
    } else {
      delete data[id];
    }
    var text = JSON.stringify(data, null, 2) + '\n';
    var body = {
      message: (value ? 'תיקון ידני (קבצים/תאריך/קישור)' : 'חזרה להתאמה אוטומטית') + ' מדף הניהול: ' + (title || id),
      content: Utilities.base64Encode(text, Utilities.Charset.UTF_8),
      branch: 'main'
    };
    if (cur.sha) body.sha = cur.sha;
    var r = gh_('put', 'contents/' + OVERRIDES, body);
    var code = r.getResponseCode();
    if (code === 200 || code === 201) return 'ok';
    if (code !== 409 && code !== 422) throw new Error('השמירה נכשלה (' + code + ')');
    Utilities.sleep(1500);
  }
  throw new Error('השמירה נכשלה, כדאי לנסות שוב');
}

// כפתור "סנכרון עכשיו". מחזיר את רגע ההפעלה כדי שהדף יוכל לעקוב אחרי הריצה (adminSyncResult)
function adminSync(key) {
  checkKey_(key);
  var cache = CacheService.getScriptCache();
  var recent = cache.get('recent');
  if (recent) return JSON.stringify({ r: 'recent', since: recent });
  var since = new Date(Date.now() - 20000).toISOString(); // מרווח קטן למקרה של הבדלי שעון
  var code = dispatch_(false);
  if (code !== 204) throw new Error('הסנכרון לא הופעל (קוד ' + code + ')');
  cache.put('recent', since, 60);
  return JSON.stringify({ r: 'ok', since: since });
}

// מצב הסנכרון שהופעל ב-since: waiting / running / failed, או done עם כל השיעורים (הדף משווה למה שהיה לפני הסנכרון)
function adminSyncResult(key, since) {
  checkKey_(key);
  var r = gh_('get', 'actions/workflows/' + WORKFLOW + '/runs?event=workflow_dispatch&branch=main&per_page=5&created=' +
    encodeURIComponent('>=' + String(since).slice(0, 19) + 'Z'));
  if (r.getResponseCode() !== 200) throw new Error('בדיקת הריצה נכשלה (' + r.getResponseCode() + ')');
  var runs = JSON.parse(r.getContentText()).workflow_runs || [];
  if (!runs.length) return JSON.stringify({ state: 'waiting' });
  var run = runs[0];
  if (run.status !== 'completed') return JSON.stringify({ state: 'running' });
  if (run.conclusion !== 'success') return JSON.stringify({ state: 'failed', url: run.html_url });
  var L = windowVar_(raw_('data/lessons.js'), 'LESSONS_DATA');
  var extra = (windowVar_(raw_('data/media.js'), 'MEDIA_DATA').extra || {}).videos || {};
  var all = {};
  [L.videos || {}, extra].forEach(function (vs) {
    Object.keys(vs).forEach(function (id) { all[id] = { t: vs[id].title, d: vs[id].published || '' }; });
  });
  return JSON.stringify({ state: 'done', lessons: all });
}
