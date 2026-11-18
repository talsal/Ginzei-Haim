# גנזי חיים (שיעורי הרב יואל חקון)

אתר סטטי שמציג את כל השיעורים של הרב יואל מיוטיוב, לפי נושאים, עם חיפוש, מועדפים, "המשך האזנה" ונגן מובנה.
מבוסס על [playlist-viewer](https://github.com/talsal/playlist-viewer).

## איך זה עובד
- `index.html` הוא האתר עצמו (קובץ אחד, בלי תלויות).
- `data/lessons.js` מכיל את רשימת השיעורים. **הוא נוצר אוטומטית**, אין לערוך אותו ידנית.
- `scripts/sync.mjs` מושך מיוטיוב את כל הפלייליסטים והסרטונים של הערוצים שב-`config.json` (`channels`) וכותב את `data/lessons.js`.
- `.github/workflows/sync.yml` מריץ את הסנכרון כל יום, שומר את השינויים ומפרסם את האתר ל-GitHub Pages.
  שיעור חדש ביוטיוב מופיע באתר תוך יום לכל היותר.

## הגדרה חד-פעמית
1. ב-`config.json`, ברשימה `channels`, לשים את כתובות הערוצים (`handle`, למשל `@ravyoel`). לערוץ שיש בו גם רבנים אחרים מוסיפים `filter` עם מילים מהכותרת.
2. ליצור מפתח YouTube Data API v3:
   [Google Cloud Console](https://console.cloud.google.com/) → פרויקט חדש → APIs & Services → Library →
   "YouTube Data API v3" → Enable → Credentials → Create credentials → API key.
   מומלץ להגביל את המפתח ל-YouTube Data API v3 בלבד.
3. בריפו ב-GitHub: Settings → Secrets and variables → Actions → New repository secret,
   בשם `YT_API_KEY` עם המפתח.
4. Settings → Pages → Source: **GitHub Actions**.
5. Actions → "סנכרון שיעורים ופרסום" → Run workflow.

הסנכרון צורך בערך 100–200 יחידות ביום מתוך 10,000 החינמיות.

## קבצי שמע ו-PDF (Cloudflare R2)
לכל שיעור אפשר להוסיף האזנה, הורדת mp3 ודף מקורות. הקבצים לא נשמרים בריפו אלא ב-Cloudflare R2 (הורדות חינם).
- `scripts/media-import.mjs` מעתיק את הקבצים מהאתר הישן של הישיבה אל R2 ומחבר כל קובץ לשיעור לפי מזהה היוטיוב שרשום שם.
  הוא כותב את `data/media.js` (מה שהאתר קורא) ואת `data/media-manifest.json` (כל 2,107 השיעורים בישן, כולל הקלטות ללא וידאו).
- מפעילים מ-Actions → "העתקת mp3 ו-PDF..." → Run workflow. אפשר להריץ שוב ושוב, קובץ שכבר ב-R2 מדלגים עליו.
- סודות נדרשים בריפו: `R2_ENDPOINT`, `R2_BUCKET`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`.
- **שיעורים חדשים (אוטומטי):** בכל בדיקה מהירה (כל 10 דקות) `scripts/media-match.mjs` בודק את R2 ומקשר קבצי mp3 חדשים לשיעור לפי שם הקובץ:
  תאריך השיעור בתחילת השם וקוד המקום בסוף, למשל `JH-26-11-18 Tfila - Kuz - BVG.mp3` (הקודים ב-`placeCodes` ב-`config.json`).
  התאריך יכול להיות יום הפרסום ביוטיוב או עד 3 ימים לפני (פרמיירה למחרת). התיקייה לא משנה.
  דף המקורות: ה-PDF האחרון באותה תיקייה שהתאריך שלו עד יום השיעור. מה שלא הותאם רשום ב-`data/media-report.json`.
- **תיקון ידני:** `data/media-overrides.json` (מזהה סרטון → `a` קובץ שמע, `p` רשימת PDF). גובר על הכול.
- ב-`config.json` יש לשים ב-`mediaBaseUrl` את הכתובת הציבורית של הבאקט (בלי `/` בסוף). כל עוד היא ריקה, הכפתורים לא מופיעים.

## דף הניהול של הרב (כפתור סנכרון + קבצים)
התזמון של GitHub ("כל 15 דקות") בפועל מתעכב ורץ רק כמה פעמים ביום. לכן יש סקריפט קטן ב-Google Apps Script, חינמי,
([`tools/sync-button.gs`](tools/sync-button.gs) + [`tools/admin.html`](tools/admin.html)) שעושה שני דברים:
- **בדיקה אוטומטית כל 10 דקות**: אם הועלה סרטון חדש או קובץ חדש ל-R2, הוא מופיע באתר בלי שאף אחד יעשה כלום.
- **דף ניהול לרב** (קישור עם סיסמה): רשימת השיעורים עם קובצי השמע וה-PDF שלהם, שינוי ידני של הקבצים לכל שיעור,
  וכפתור "סנכרון עכשיו". שינוי ידני נשמר ב-`data/media-overrides.json` וגובר על ההתאמה האוטומטית.

הטוקן של GitHub שמור רק בתוך הסקריפט של גוגל, לא באתר ולא בקישור.

התקנה חד-פעמית:
1. **טוקן ב-GitHub**: [Fine-grained tokens](https://github.com/settings/personal-access-tokens) →
   Repository access: Only select repositories → `Ginzei-Haim` → Permissions → Actions: **Read and write** ו-Contents: **Read and write**. להעתיק.
2. **הסקריפט**: [script.new](https://script.new) → למחוק את מה שיש ולהדביק את התוכן של `tools/sync-button.gs` → שמירה.
   ואז **+** ליד Files → HTML → בשם `admin` → להדביק את התוכן של `tools/admin.html` → שמירה.
3. **סודות**: גלגל השיניים (Project Settings) → Script Properties → להוסיף `GITHUB_TOKEN` (הטוקן) ו-`SYNC_KEY` (סיסמה קצרה, למשל מילה ומספר).
4. **בדיקה אוטומטית**: בעורך לבחור את הפונקציה `installTrigger` → Run → לאשר הרשאות (Advanced → Go to project).
5. **הקישור**: Deploy → New deployment → סוג Web app → Execute as: **Me**, Who has access: **Anyone** → Deploy.
   הקישור של הרב: כתובת ה-Web app ועוד `?key=` והסיסמה, למשל `https://script.google.com/macros/s/.../exec?key=SISMA`.
   אחרי עדכון קוד: Deploy → Manage deployments → עריכה (עיפרון) → Version: New version → Deploy (הקישור נשאר אותו קישור).

## העברת שיעורים לערוץ החדש
סקריפט העלאה והעתקת כותרת/תיאור/סדרה בין הערוצים, והמדריך המלא ב-[`tools/youtube-uploader/README.md`](tools/youtube-uploader/README.md).
שיעור שקיים בשני הערוצים באותה כותרת מוצג באתר פעם אחת (מהערוץ החדש, עם התאריך והקבצים של המקור).

## נושאים (קטגוריות)
כל פלייליסט ביוטיוב הופך לנושא באתר. כדי לקבץ פלייליסטים לקטגוריות, עורכים את `categories` ב-`config.json`:
פלייליסט שייך לקטגוריה הראשונה שה-`playlistIds` שלה מכיל אותו, או שאחת מה-`keywords` שלה מופיעה בשם שלו.
פלייליסט שלא התאים לשום קטגוריה נכנס ל-`other`. סרטונים שלא נמצאים באף פלייליסט מופיעים תחת "שיעורים נוספים".

## הרצה מקומית
```bash
YT_API_KEY=... node scripts/sync.mjs   # מעדכן את data/lessons.js
open index.html                        # פותח את האתר בדפדפן
```

## בהמשך
- קבצי mp3 (Cloudflare R2) וכפתור הורדה לכל שיעור, ופיד פודקאסט.
- קבצי PDF.
- שאלות ותשובות בעזרת AI.
