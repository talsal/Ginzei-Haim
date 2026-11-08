# גנזי חיים (שיעורי הרב יואל חקון)

אתר סטטי שמציג את כל השיעורים של הרב יואל מיוטיוב, לפי נושאים, עם חיפוש, מועדפים, "המשך האזנה" ונגן מובנה.
מבוסס על [playlist-viewer](https://github.com/talsal/playlist-viewer).

## איך זה עובד
- `index.html` הוא האתר עצמו (קובץ אחד, בלי תלויות).
- `data/lessons.js` מכיל את רשימת השיעורים. **הוא נוצר אוטומטית**, אין לערוך אותו ידנית.
- `scripts/sync.mjs` מושך מיוטיוב את כל הפלייליסטים והסרטונים של הערוץ וכותב את `data/lessons.js`.
- `.github/workflows/sync.yml` מריץ את הסנכרון כל יום, שומר את השינויים ומפרסם את האתר ל-GitHub Pages.
  שיעור חדש ביוטיוב מופיע באתר תוך יום לכל היותר.

## הגדרה חד-פעמית
1. ב-`config.json` לשים את כתובת הערוץ (`channelHandle`, למשל `@ravyoel`).
2. ליצור מפתח YouTube Data API v3:
   [Google Cloud Console](https://console.cloud.google.com/) → פרויקט חדש → APIs & Services → Library →
   "YouTube Data API v3" → Enable → Credentials → Create credentials → API key.
   מומלץ להגביל את המפתח ל-YouTube Data API v3 בלבד.
3. בריפו ב-GitHub: Settings → Secrets and variables → Actions → New repository secret,
   בשם `YT_API_KEY` עם המפתח.
4. Settings → Pages → Source: **GitHub Actions**.
5. Actions → "סנכרון שיעורים ופרסום" → Run workflow.

הסנכרון צורך בערך 100–200 יחידות ביום מתוך 10,000 החינמיות.

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
