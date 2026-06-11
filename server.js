const express = require('express');
const { Pool } = require('pg');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

// ==========================================
// 1. חיבור למסד הנתונים
// ==========================================
const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }
});

pool.on('error', (err) => console.error('DB Pool Error:', err.message));
app.set('db', pool);

app.use(express.urlencoded({ extended: true }));
app.use(express.json());

app.use((req, res, next) => {
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    next();
});

// ==========================================
// 2. MIDDLEWARE CONTEXT (חסין קריסות לחלוטין)
// ==========================================
app.use((req, res, next) => {
    const apiPhone = req.query.ApiPhone || req.body.ApiPhone || '0500000000';
    const apiCallId = req.query.ApiCallId || req.body.ApiCallId || 'test_' + Date.now();

    req.telephony = {
        phone: apiPhone,
        callId: apiCallId
    };
    next();
});

// ==========================================
// 3. ROUTING SYSTEM (בלי נקודות, בלי אנגלית!)
// ==========================================

app.get('/api/v1/auth', async (req, res) => {
    const db = req.app.get('db');
    const { phone } = req.telephony;
    
    // קליטת המקשים במקום בטוח בלבד
    const digits = req.query.digits || req.body.digits || null;

    try {
        const userQuery = `
            SELECT u.id as user_id, u.family_id, u.is_approved, t.tenant_name 
            FROM users u
            JOIN tenants t ON u.family_id = t.family_id
            WHERE u.phone_number = $1 AND t.is_active = TRUE
        `;
        const result = await db.query(userQuery, [phone]);

        // תרחיש 1: משתמש קיים ומאושר
        if (result && result.rows && result.rows.length > 0 && result.rows[0].is_approved) {
            const user = result.rows[0];
            return res.send(`id_list_message=t-ברוכים הבאים למערכת המשפחתית של ${user.tenant_name} לשמיעת הודעות הקש 1 להקלטת הודעה חדשה הקש 2&read=t-נא להקיש בחירה ולאחריה סולמית=digits,yes,1,1,7,Number,no`);
        }

        // תרחיש 2: משתמש רשום אך ממתין לאישור
        if (result && result.rows && result.rows.length > 0 && !result.rows[0].is_approved) {
            return res.send('id_list_message=t-חשבונך ממתין לאישור מנהל המשפחה אנא נסה שנית מאוחר יותר&hangup=yes');
        }

        // תרחיש 3: משתמש חדש - שלב א' בקשת קוד
        if (!digits) {
            return res.send('read=t-שלום מספרכם אינו מוכר במערכת אנא הקישו את קוד ההצטרפות המשפחתי שלכם ולאחריו סולמית=digits,yes,6,6,10,Number,no');
        }

        // תרחיש 4: משתמש חדש - שלב ב' בדיקת הקוד שהוקש
        const tenantCheck = await db.query('SELECT family_id, tenant_name FROM tenants WHERE join_code = $1 AND is_active = true', [digits]);
        
        if (!tenantCheck || tenantCheck.rows.length === 0) {
            return res.send('id_list_message=t-קוד משפחתי שגוי או לא פעיל המערכת מנתקת&hangup=yes');
        }

        const tenant = tenantCheck.rows[0];

        // הרשמה למסד הנתונים
        await db.query(
            'INSERT INTO users (family_id, phone_number, user_name, role, is_approved) VALUES ($1, $2, $3, $4, $5) ON CONFLICT DO NOTHING',
            [tenant.family_id, phone, 'משתמש חדש', 'user', false]
        );

        return res.send(`id_list_message=t-בקשתכם להצטרפות למשפחת ${tenant.tenant_name} נקלטה בהצלחה ומועברת לאישור המנהל&hangup=yes`);

    } catch (error) {
        console.error('Auth Route Internal Error:', error.message);
        // שגיאה נקייה בלי תווים אסורים
        return res.send('id_list_message=t-תקלה זמנית בגישה למסד הנתונים אנא נסו שוב מאוחר יותר&hangup=yes');
    }
});

// תופס שגיאות קצה - נקי מנקודות
app.use((err, req, res, next) => {
    console.error('Global Error Handler Triggered:', err.stack);
    res.status(200).send('id_list_message=t-אירעה שגיאה כללית בקוד השרת&hangup=yes');
});

app.listen(PORT, () => console.log(`Server running on port ${PORT}`));