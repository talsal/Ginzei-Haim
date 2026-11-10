/**
 * כפתור הסנכרון של הרב (Google Apps Script)
 *
 * מה זה עושה:
 *  1. doGet: קישור שהרב שומר במועדפים / במסך הבית בטלפון. לחיצה עליו מפעילה סנכרון מלא של האתר.
 *  2. quickCheck: רץ אוטומטית כל 10 דקות (טריגר זמן) ומפעיל "בדיקה מהירה",
 *     כי התזמון של GitHub עצמו מתעכב ולפעמים רץ רק כמה פעמים ביום.
 *
 * הטוקן של GitHub שמור ב-Script Properties (לא בקוד ולא באתר הציבורי), ולכן אף אחד לא רואה אותו.
 * הוראות התקנה: ראו README.md, בסעיף "כפתור סנכרון לרב".
 *
 * Script Properties שצריך להגדיר:
 *   GITHUB_TOKEN  טוקן fine-grained עם הרשאת Actions: Read and write לריפו Ginzei-Haim בלבד
 *   SYNC_KEY      סיסמה קצרה שמופיעה בקישור של הרב (?key=...), כדי שזרים לא יפעילו סנכרון
 */

var REPO = 'talsal/Ginzei-Haim';
var WORKFLOW = 'sync.yml';
var SITE_URL = 'https://talsal.github.io/Ginzei-Haim/';

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

// הקישור של הרב
function doGet(e) {
  var key = PropertiesService.getScriptProperties().getProperty('SYNC_KEY');
  if (key && (!e || !e.parameter || e.parameter.key !== key)) {
    return page_('הקישור לא תקין', 'חסרה או שגויה הסיסמה בקישור. כדאי לבקש את הקישור המלא מחדש.', false);
  }
  // הגנה מלחיצות כפולות: לא יותר מהפעלה אחת בדקה
  var cache = CacheService.getScriptCache();
  if (cache.get('recent')) {
    return page_('הסנכרון כבר רץ', 'הסנכרון הופעל לפני פחות מדקה. האתר יתעדכן בעוד כ-2 דקות.', true);
  }
  var code;
  try { code = dispatch_(false); } catch (err) { code = String(err); }
  if (code === 204) {
    cache.put('recent', '1', 60);
    return page_('הסנכרון הופעל ✓', 'השיעורים החדשים יופיעו באתר בעוד כ-2 דקות.', true);
  }
  return page_('משהו השתבש', 'הסנכרון לא הופעל (קוד ' + code + '). כדאי לעדכן את טל.', false);
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
