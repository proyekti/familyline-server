const express = require('express');
const { Pool } = require('pg');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

// ==========================================
// 1. חיבור למסד הנתונים (PostgreSQL)
// ==========================================
const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }
});

pool.on('error', (err) => console.error('DB Error:', err.message));
app.set('db', pool);

app.use(express.urlencoded({ extended: true }));
app.use(express.json());

// הגדרת פלט כטקסט נקי - קריטי עבור ימות המשיח
app.use((req, res, next) => {
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    next();
});

// ==========================================
// 2. MIDDLEWARE: חילוץ נתוני טלפוניה ו-Session
// ==========================================
app.use((req, res, next) => {
    const apiPhone = req.query.ApiPhone || req.body.ApiPhone || '0500000000';
    const apiCallId = req.query.ApiCallId || req.body.ApiCallId || 'test_' + Date.now();
    
    // שליפת הספרות שהמשתמש הקיש (אם חזר משלבי read)
    const digits = req.query.digits || req.body.digits || null;

    req.telephony = {
        phone: apiPhone,
        callId: apiCallId,
        digits: digits
    };
    next();
});

// ==========================================
// 3. הראוטר המרכזי והאפיון המלא
// ==========================================

/**
 * שלוחה ראשית: אימות כניסה וזיהוי משפחתי (Multi-Tenant)
 */
app.get('/api/v1/auth', async (req, res) => {
    const db = req.app.get('db');
    const { phone, digits } = req.telephony;

    try {
        // בדיקה האם המספר רשום ומאושר
        const userQuery = `
            SELECT u.id as user_id, u.family_id, u.is_approved, t.tenant_name 
            FROM users u
            JOIN tenants t ON u.family_id = t.family_id
            WHERE u.phone_number = $1 AND t.is_active = TRUE
        `;
        const result = await db.query(userQuery, [phone]);

        // תרחיש א': המשתמש רשום ומאושר במערכת
        if (result.rows.length > 0 && result.rows[0].is_approved) {
            const user = result.rows[0];
            return res.send(`id_list_message=t-ברוכים הבאים למערכת המשפחתית של ${user.tenant_name}.&read=t-להאזנה להודעות הקש 1. להקלטת הודעה חדשה הקש 2.=digits,yes,1,1,7,Number,no`);
        }

        // תרחיש ב': המשתמש רשום אך ממתין לאישור מנהל
        if (result.rows.length > 0 && !result.rows[0].is_approved) {
            return res.send('id_list_message=t-חשבונך ממתין לאישור מנהל המשפחה. אנא נסה שנית מאוחר יותר.&hangup=yes');
        }

        // תרחיש ג': משתמש חדש לחלוטין - תהליך רישום אוטומטי (קוד משפחתי)
        if (!digits) {
            return res.send('read=t-שלום. מספרכם אינו מוכר במערכת. אנא הקישו את קוד ההצטרפות המשפחתי שלכם ולאחריו סולמית.=digits,yes,6,6,10,Number,no');
        }

        // בדיקת הקוד שהוקש מול טבלת המשפחות
        const tenantCheck = await db.query('SELECT family_id, tenant_name FROM tenants WHERE join_code = $1 AND is_active = true', [digits]);
        
        if (tenantCheck.rows.length === 0) {
            return res.send('id_list_message=t-קוד משפחתי שגוי או לא פעיל.&hangup=yes');
        }

        const tenant = tenantCheck.rows[0];

        // יצירת המשתמש במצב ממתין (Pending)
        await db.query(
            'INSERT INTO users (family_id, phone_number, user_name, role, is_approved) VALUES ($1, $2, $3, $4, $5) ON CONFLICT DO NOTHING',
            [tenant.family_id, phone, 'משתמש חדש', 'user', false]
        );

        return res.send(`id_list_message=t-בקשתכם להצטרפות למשפחת ${tenant.tenant_name} נקלטה בהצלחה, ומועברת לאישור המנהל.&hangup=yes`);

    } catch (error) {
        console.error('Auth Error:', error.message);
        return res.send('id_list_message=t-שגיאת מערכת בתהליך הזיהוי.&hangup=yes');
    }
});

/**
 * שלוחה 1: האזנת פינג-פונג דינמית להודעות חיות
 */
app.get('/api/v1/listen', async (req, res) => {
    const db = req.app.get('db');
    const { phone, digits } = req.telephony;

    try {
        // שליפת פרטי המשתמש והמשפחה שלו
        const userResult = await db.query('SELECT id, family_id FROM users WHERE phone_number = $1 AND is_approved = true', [phone]);
        if (userResult.rows.length === 0) return res.send('go_to_folder=/');
        
        const user = userResult.rows[0];

        // לוגיקה זמנית: במידה ואין עדיין הודעות במסד, נשמיע הודעת מערכת קבועה
        const msgQuery = `SELECT id, file_path FROM messages WHERE family_id = $1 AND is_deleted = false ORDER BY created_at DESC LIMIT 1`;
        const msgResult = await db.query(msgQuery, [user.family_id]);

        if (msgResult.rows.length === 0) {
            return res.send('id_list_message=t-אין הודעות חדשות בקו המשפחתי.&go_to_folder=/');
        }

        // השמעת ההודעה האחרונה שנמצאה
        const message = msgResult.rows[0];
        return res.send(`id_list_message=f-${message.file_path}&read=t-לשמיעה חוזרת הקש 1. למחיקת ההודעה הקש 7.=digits,yes,1,1,7,Number,no`);

    } catch (error) {
        return res.send('id_list_message=t-שגיאה בשלוחת ההאזנה.&go_to_folder=/');
    }
});

/**
 * שלוחה 2: הקלטת הודעה חדשה
 */
app.get('/api/v1/send', async (req, res) => {
    // שלב זה מכין את המערכת לקבלת קובץ ההקלטה הפיזי מימות המשיח
    return res.send('id_list_message=t-שלוחת ההקלטה מוכנה. אנא הקליטו את הודעתכם לאחר הצליל.&hangup=yes');
});

// טיפול בשגיאות מערכת
app.use((err, req, res, next) => {
    res.status(200).send('id_list_message=t-אירעה שגיאה כללית זמנית.&hangup=yes');
});

app.listen(PORT, () => console.log(`Server running on port ${PORT}`));