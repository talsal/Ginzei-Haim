# בקשת ביקורת והגדלת מכסה ל-YouTube API

הטופס: https://support.google.com/youtube/contact/yt_api_form (אם הקישור השתנה: חיפוש "YouTube API Services Audit and Quota Extension Form").
הטקסטים באנגלית, כי הטופס נבדק על ידי צוות של גוגל. את הפרטים בסוגריים מרובעים ממלאים.

**הערה (נובמבר 2026): ככל הנראה כבר לא נחוץ.** ברירת המחדל היום היא 100 העלאות ביום, והנעילה כפרטי בוטלה ב-2 בנובמבר 2026 (ראו README). המסמך נשאר למקרה שנצטרך יותר מ-100 העלאות ביום.

**המצב הישן (לפני):** פרויקט API שלא עבר ביקורת: (1) סרטונים שמועלים דרכו ננעלים כ-**פרטיים** (private), (2) המכסה הייתה 10,000 יחידות ליום, כלומר כ-6 העלאות ביום.
אם הרב מעלה ידנית ב-YouTube Studio, אין בעיה עם (1), והסקריפט במצב `--fix-only` צורך רק כ-100 סרטונים ליום ולא צריך הגדלה.

## Application / project description
Ginzei Haim is a free, non-commercial archive of Torah lessons by Rabbi Yoel Hakkon, published on the rabbi's own YouTube channel (https://www.youtube.com/@ginzei-haim) and shown on a free website (https://ginzei-haim.org).
The rabbi is migrating about 1,250 existing lessons of his own, recorded over many years, from an old shared yeshiva channel to his own channel. We built a small command-line tool that the channel owner runs on his own computer. It is not a public service and has a single user, the channel owner.

## How the API is used
The tool signs in once with OAuth as the channel owner (scope: youtube) and:
1. uploads the rabbi's own local video files (videos.insert, resumable upload),
2. sets the title, description, tags and recording date copied from the same lesson on the old channel (videos.update),
3. adds each video to the matching playlist, creating it if needed (playlists.insert, playlistItems.insert),
4. reads public metadata of the old videos (videos.list) and lists the new channel's videos (channels.list, playlistItems.list).
It never reads or modifies any other user's content, does not store user data, and the OAuth token stays on the channel owner's computer. It does not use the API to collect comments, analytics or personal data.

## Quota request
(Only if more than the default 100 uploads/day is needed. The current default is 100 videos.insert calls per day, so migrating about 1,250 lessons takes about 13 days.)
We request [100,000] units per day for a limited period (about 3 months) to finish the migration. After that the tool will only upload new weekly lessons (about 6 per week), which fits the default quota.

## Compliance
- The project is used only by its owner; there are no third-party users.
- Content is uploaded only by the rights holder (the rabbi and his yeshiva) to the rabbi's own channel.
- Contact: [אימייל של Tal או של הרב].
