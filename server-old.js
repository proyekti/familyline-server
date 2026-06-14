const express = require('express');
const { Pool } = require('pg');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

// חיבור רשמי ויציב למסד הנתונים
const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }
});

app.use(express.urlencoded({ extended: true }));
app.use(express.json());

// חובה לפי הגדרות ימות המשיח - החזרת טקסט נקי בלבד
app.use((req, res, next) => {
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    next();
});

// ====================================================
// 1. שלוחה ראשית: זיהוי, רישום ותפריט ראשי
// ====================================================
app.get('/api/v1/auth', async (req, res) => {
    const phone = req.query.ApiPhone || req.body.ApiPhone || '0500000000';
    const apiDigits = req.query.ApiDigits || req.body.ApiDigits || null;

    try {
        const userQuery = `
            SELECT u.id as user_id, u.family_id, u.is_approved, t.tenant_name 
            FROM users u
            JOIN tenants t ON u.family_id = t.family_id
            WHERE u.phone_number = $1 AND t.is_active = TRUE
        `;
        const result = await pool.query(userQuery, [phone]);

        // תרחיש א: משתמש קיים ומאושר - משמיעים תפריט ומחכים לבחירה (1 או 2)
        if (result && result.rows.length > 0 && result.rows[0].is_approved) {
            const user = result.rows[0];

            // אם המשתמש כבר הקיש בחירה בתפריט
            if (apiDigits === '1') return res.send('go_to_folder=/1');
            if (apiDigits === '2') return res.send('go_to_folder=/2');

            // השמעת התפריט הראשי
            return res.send(`read=t-ברוכים הבאים למערכת המשפחתית של ${user.tenant_name} להאזנה להודעות הקש 1 להקלטת הודעה חדשה הקש 2=ApiDigits,yes,1,1,7,Number,no`);
        }

        // תרחיש ב: משתמש רשום אך ממתין לאישור מנהל
        if (result && result.rows.length > 0 && !result.rows[0].is_approved) {
            return res.send('id_list_message=t-חשבונך ממתין לאישור מנהל המשפחה אנא נסה שנית מאוחר יותר&hangup=yes');
        }

        // תרחיש ג: משתמש חדש - שלב א': בקשת קוד הצטרפות
        if (!apiDigits) {
            return res.send('read=t-שלום מספרכם אינו מוכר במערכת אנא הקישו את קוד ההצטרפות המשפחתי שלכם ולאחריו סולמית=ApiDigits,yes,6,6,10,Number,no');
        }

        // תרחיש ד: משתמש חדש - שלב ב': בדיקת הקוד שהוקש
        const tenantCheck = await pool.query('SELECT family_id, tenant_name FROM tenants WHERE join_code = $1 AND is_active = true', [apiDigits]);
        
        if (!tenantCheck || tenantCheck.rows.length === 0) {
            return res.send('id_list_message=t-קוד משפחתי שגוי או לא פעיל המערכת מנתקת&hangup=yes');
        }

        const tenant = tenantCheck.rows[0];
        await pool.query(
            'INSERT INTO users (family_id, phone_number, user_name, role, is_approved) VALUES ($1, $2, $3, $4, $5) ON CONFLICT DO NOTHING',
            [tenant.family_id, phone, 'משתמש חדש', 'user', false]
        );

        return res.send(`id_list_message=t-בקשתכם להצטרפות למשפחת ${tenant.tenant_name} נקלטה בהצלחה ומועברת לאישור המנהל&hangup=yes`);

    } catch (error) {
        console.error('Auth Error:', error.message);
        return res.send('id_list_message=t-אירעה שגיאה כללית זמנית אנא נסו שנית מאוחר יותר&hangup=yes');
    }
});

// ====================================================
// 2. שלוחה 1: האזנה להודעות וניהול (שמיעה חוזרת/מחיקה)
// ====================================================
app.get('/api/v1/listen', async (req, res) => {
    const phone = req.query.ApiPhone || req.body.ApiPhone || '0500000000';
    const apiDigits = req.query.ApiDigits || req.body.ApiDigits || null;

    try {
        // שליפת פרטי המשתמש והמשפחה
        const userResult = await pool.query('SELECT id, family_id FROM users WHERE phone_number = $1 AND is_approved = true', [phone]);
        if (!userResult || userResult.rows.length === 0) {
            return res.send('id_list_message=t-גישה חסומה המערכת מנתקת&hangup=yes');
        }

        const { id: userId, family_id: familyId } = userResult.rows[0];

        // שליפת ההודעה האחרונה שלא נמחקה של המשפחה הזו
        const msgResult = await pool.query(
            'SELECT id, file_path FROM messages WHERE family_id = $1 AND is_deleted = false ORDER BY id DESC LIMIT 1',
            [familyId]
        );

        if (!msgResult || msgResult.rows.length === 0) {
            return res.send('id_list_message=t-אין הודעות חדשות בקו המשפחתי מועברים לתפריט הראשי&go_to_folder=/');
        }

        const message = msgResult.rows[0];

        // טיפול במקשים (אם המשתמש כבר שמע את ההודעה והקיש)
        if (apiDigits === '1') {
            // שמיעה חוזרת - נטען את אותה שלוחה מחדש
            return res.send('go_to_folder=current');
        }
        if (apiDigits === '7') {
            // מחיקת ההודעה הנוכחית ב-Database
            await pool.query('UPDATE messages SET is_deleted = true WHERE id = $1', [message.id]);
            return res.send('id_list_message=t-ההודעה נמחקה בהצלחה מועברים לתפריט הראשי&go_to_folder=/');
        }

        // השמעת קובץ השמע מהנתיב השמור (f- משמיע קובץ פיזי מימות), ואז תפריט אפשרויות
        return res.send(`id_list_message=f-${message.file_path}&read=t-לשמיעה חוזרת הקש 1 למחיקת ההודעה הקש 7=ApiDigits,yes,1,1,7,Number,no`);

    } catch (error) {
        console.error('Listen Error:', error.message);
        return res.send('id_list_message=t-תקלה זמנית בשלוחת ההאזנה חוזרים לתפריט הראשי&go_to_folder=/');
    }
});

// ====================================================
// 3. שלוחה 2: הקלטת הודעה חדשה ושמירתה ב-Database
// ====================================================
app.get('/api/v1/record', async (req, res) => {
    const phone = req.query.ApiPhone || req.body.ApiPhone || '0500000000';
    
    // ימות המשיח שולחת את נתיב קובץ השמע שהוקלט בפרמטר ה-API הרשמי FileUrl
    const fileUrl = req.query.FileUrl || req.body.FileUrl || null;

    try {
        const userResult = await pool.query('SELECT id, family_id FROM users WHERE phone_number = $1 AND is_approved = true', [phone]);
        if (!userResult || userResult.rows.length === 0) {
            return res.send('id_list_message=t-גישה חסומה המערכת מנתקת&hangup=yes');
        }

        const { id: userId, family_id: familyId } = userResult.rows[0];

        // אם השיחה רק נכנסה ועדיין אין קובץ מוקלט, ימות המשיח צריכה להפעיל את פקודת ההקלטה המובנית שלה
        if (!fileUrl) {
            // פקודה רשמית של ימות המשיח להקלטה בשלוחת API
            return res.send('type=record&record_path=current&record_ok_go_to=current');
        }

        // ברגע שההקלטה הסתיימה בהצלחה, ימות המשיח פונה שוב עם ה-FileUrl ופה אנחנו שומרים אותו ב-DB
        await pool.query(
            'INSERT INTO messages (family_id, sender_id, file_path, is_deleted) VALUES ($1, $2, $3, false)',
            [familyId, userId, fileUrl]
        );

        return res.send('id_list_message=t-הודעתכם הוקלטה ונשמרה בהצלחה בקו המשפחתי מועברים לתפריט הראשי&go_to_folder=/');

    } catch (error) {
        console.error('Record Error:', error.message);
        return res.send('id_list_message=t-תקלה זמנית בתהליך ההקלטה חוזרים לתפריט הראשי&go_to_folder=/');
    }
});

app.listen(PORT, () => console.log(`FamilyLine Server Production Ready on port ${PORT}`));