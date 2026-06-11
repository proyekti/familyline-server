const express = require('express');
const { Pool } = require('pg');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

// ==========================================
// 1. חיבור לבסיס הנתונים (PostgreSQL)
// ==========================================
const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false } // נדרש עבור חיבור מאובטח ל-Render
});

// בדיקת חיבור ראשוני למסד
pool.connect((err, client, release) => {
    if (err) {
        return console.error('Error acquiring client', err.stack);
    }
    console.log('Successfully connected to PostgreSQL Database on Render.');
    release();
});

// חשיפת ה-Pool לשימוש רוחבי בשרת
app.set('db', pool);

// הגדרת פלט כטקסט נקי - קריטי עבור ימות המשיח
app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use((req, res, next) => {
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    next();
});

// ==========================================
// 2. MIDDLEWARES: ניהול Context ו-SaaS Tenant
// ==========================================

/**
 * מנטר ומחלץ את נתוני השיחה הבסיסיים של ימות המשיח.
 * מוודא קיום של ApiCallId ו-ApiPhone.
 */
const y_telephonyContext = async (req, res, next) => {
    // ימות המשיח שולחת פרמטרים ב-Query String (GET) או ב-Body (POST)
    const apiPhone = req.query.ApiPhone || req.body.ApiPhone;
    const apiCallId = req.query.ApiCallId || req.body.ApiCallId;
    const apiExtension = req.query.ApiExtension || req.body.ApiExtension;

    if (!apiCallId) {
        // אם אין ApiCallId, זו פנייה לא חוקית שלא הגיעה מהמרכזייה
        return res.send('id_list_message=t-שגיאת מערכת. שיחה לא מזוהה.');
    }

    // שמירת הנתונים על אובייקט ה-Request לשימוש בהמשך הצינור
    req.telephony = {
        phone: apiPhone || 'חסוי',
        callId: apiCallId,
        extension: apiExtension
    };

    next();
};

/**
 * שכבת ה-Multi-Tenant: מזהה את ה-family_id והרשאות המשתמש לפי מספר הטלפון
 */
const tenantAuthenticator = async (req, res, next) => {
    const db = req.app.get('db');
    const { phone } = req.telephony;

    // החרגה לשלוחת כניסה/אימות: אם משתמש חדש מנסה להירשם, עדיין אין לו Tenant
    if (req.path === '/api/v1/auth' || req.path === '/api/v1/auth/register') {
        return next();
    }

    try {
        // שליפת פרטי המשתמש והמשפחה המשויכת אליו
        const userQuery = `
            SELECT u.id as user_id, u.family_id, u.role, u.is_approved, t.tenant_name 
            FROM users u
            JOIN tenants t ON u.family_id = t.family_id
            WHERE u.phone_number = $1 AND t.is_active = TRUE
        `;
        const result = await db.query(userQuery, [phone]);

        if (result.rows.length === 0) {
            // משתמש לא רשום - מעבירים אותו אוטומטית לשלוחת האימות
            return res.send('go_to_folder=/auth');
        }

        const user = result.rows[0];

        if (!user.is_approved) {
            // משתמש רשום אך ממתין לאישור מנהל
            return res.send('id_list_message=t-חשבונך ממתין לאישור מנהל המערכת. אנא נסה שנית מאוחר יותר.&hangup=yes');
        }

        // הלבשת נתוני ה-Tenant על ה-Request
        req.tenant = {
            familyId: user.family_id,
            familyName: user.tenant_name,
            userId: user.user_id,
            role: user.role
        };

        next();
    } catch (error) {
        console.error('Tenant Auth Error:', error);
        return res.send('id_list_message=t-שגיאה בתהליך הזיהוי המשפחתי.');
    }
};

// החלת ה-Middlewares באופן גלובלי על כל הראוטרים
app.use(y_telephonyContext);
app.use(tenantAuthenticator);

// ==========================================
// 3. ROUTING SYSTEM: ניתוב שלוחות ימות המשיח
// ==========================================

// שלוחת כניסה, אימות ורישום משתמשים חדשים
app.get('/api/v1/auth', async (req, res) => {
    const db = req.app.get('db');
    const { phone } = req.telephony;
    const digits = req.query.digits; // קוד שהוקש במידה וחזר משלב קודם

    try {
        // בדיקה האם המשתמש כבר קיים ומאושר
        const checkUser = await db.query('SELECT family_id FROM users WHERE phone_number = $1 AND is_approved = true', [phone]);
        
        if (checkUser.rows.length > 0) {
            // משתמש קיים ומזוהה -> משמיעים אפקט כניסה ומעבירים לתפריט הראשי
            return res.send(`id_list_message=f-welcome_effect.t-ברוכים הבאים למערכת.&go_to_folder=/main_menu`);
        }

        // אם המשתמש לא קיים ועדיין לא הקיש קוד - נבקש קוד הצטרפות (6 ספרות)
        if (!digits) {
            return res.send('read=t-המספר אינו מוכר במערכת. אנא הקישו את קוד ההצטרפות המשפחתי שלכם ולאחריו סולמית.=digits,yes,6,6,10,Number,no');
        }

        // במידה והוקש קוד - נבצע אימות מול טבלת ה-Tenants
        const tenantCheck = await db.query('SELECT family_id, tenant_name FROM tenants WHERE join_code = $1 AND is_active = true', [digits]);
        
        if (tenantCheck.rows.length === 0) {
            return res.send('id_list_message=t-קוד שגוי או לא פעיל.&hangup=yes');
        }

        const tenant = tenantCheck.rows[0];

        // רישום המשתמש החדש תחת המשפחה שנמצאה (בהמתנה לאישור מנהל - Pending)
        await db.query(
            'INSERT INTO users (family_id, phone_number, user_name, role, is_approved) VALUES ($1, $2, $3, $4, $5) ON CONFLICT DO NOTHING',
            [tenant.family_id, phone, 'משתמש חדש', 'user', false]
        );

        // רישום ללוג ביקורת
        await db.query('INSERT INTO audit_logs (family_id, action_type, description) VALUES ($1, $2, $3)', 
            [tenant.family_id, 'LOGIN_ATTEMPT', `New registration attempt from ${phone}`]);

        return res.send(`id_list_message=t-בקשתכם להצטרפות ל${tenant.tenant_name} נקלטה ומועברת לאישור המנהל.&hangup=yes`);

    } catch (error) {
        console.error('Auth Route Error:', error);
        return res.send('id_list_message=t-שגיאה זמנית בשרת האימות.');
    }
});

// שלוחה 1: האזנה להודעות (הכנה לאינטגרציה)
app.get('/api/v1/listen', async (req, res) => {
    const { familyName, familyId } = req.tenant;
    // כאן תיושם לוגיקת הפינג-פונג של השמעת הודעה בודדת + תפריט פעולות (פרטים/מחיקה)
    return res.send(`id_list_message=t-נכנסתם לשלוחת ההאזנה של ${familyName}. שלוחה זו בבנייה.`);
});

// שלוחה 2: שליחה והקלטת הודעה חדשה (הכנה לאינטגרציה)
app.get('/api/v1/send', async (req, res) => {
    const { familyId } = req.tenant;
    // כאן תיושם קבלת מזהה ההקלטה, החלת האפקטים ובניית קבוצה זמנית לפי ה-ApiCallId
    return res.send('id_list_message=t-שלוחת שליחת הודעות בבנייה.');
});

// שלוחה 3: הרשמה והסרה משירות צינתוקים (הכנה לאינטגרציה)
app.get('/api/v1/tzintuk', async (req, res) => {
    const db = req.app.get('db');
    const { userId, familyId } = req.tenant;
    const choice = req.query.digits;

    if (!choice) {
        return res.send('read=t-להרשמה לשירות הצינתוקים המשפחתי הקש 1, להסרה הקש 2.=digits,yes,1,1,7,Number,no');
    }

    try {
        const status = (choice === '1');
        await db.query('UPDATE users SET receive_tzintuk = $1 WHERE id = $2', [status, userId]);
        
        await db.query('INSERT INTO audit_logs (family_id, user_id, action_type, description) VALUES ($1, $2, $3, $4)', 
            [familyId, userId, 'TZINTUK_TOGGLE', `User changed tzintuk status to ${status}`]);

        const msg = status ? 'נרשמתם בהצלחה לשירות הצינתוקים.' : 'הוסרתם משירות הצינתוקים המשפחתי.';
        return res.send(`id_list_message=t-${msg}&go_to_folder=/main_menu`);
    } catch (error) {
        return res.send('id_list_message=t-שגיאה בעדכון הגדרות הצינתוק.');
    }
});

// שלוחה 9: ניהול מערכת וסטטיסטיקות (למנהלים בלבד)
app.get('/api/v1/admin', async (req, res) => {
    const { role, familyId } = req.tenant;

    if (role !== 'admin' && role !== 'owner') {
        return res.send('id_list_message=t-אין לך הרשאת מנהל באזור זה.&go_to_folder=/main_menu');
    }

    // כאן ייושמו הסטטיסטיקות, הוספה/הסרה ואישור חברים
    return res.send('id_list_message=t-ברוכים הבאים לתפריט הניהול הקהילתי. שלוחה זו בבנייה.');
});

// גלובלי לטיפול בשגיאות שרת
app.use((err, req, res, next) => {
    console.error('Global Error Handler:', err.stack);
    res.status(500).send('id_list_message=t-שגיאה כללית בשרת האפליקציה.');
});

// הפעלת האזנה לשרת
app.listen(PORT, () => {
    console.log(`FamilyLine Server is running on port ${PORT}`);
});