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
// 2. MIDDLEWARE CONTEXT (בטוח וחסין קריסות)
// ==========================================
app.use((req, res, next) => {
    // חילוץ בטוח ללא נפילות של נתוני ימות המשיח
    const apiPhone = req.query.ApiPhone || req.body.ApiPhone || '0500000000';
    const apiCallId = req.query.ApiCallId || req.body.ApiCallId || 'test_' + Date.now();

    req.telephony = {
        phone: apiPhone,
        callId: apiCallId
    };
    next();
});

// ==========================================
// 3. ROUTING SYSTEM
// ==========================================

app.get('/api/v1/auth', async (req, res) => {
    const db = req.app.get('db');
    const { phone } = req.telephony;
    
    // שליפת ה-digits מתבצעת רק כאן, במקום הבטוח שלה!
    const digits = req.query.digits || req.body.digits || null;

    try {
        const userQuery = `
            SELECT u.id as user_id, u.family_id, u.is_approved, t.tenant_name 
            FROM users u
            JOIN tenants t ON u.family_id = t.family_id
            WHERE u.phone_number = $1 AND t.is_active = TRUE
        `;
        const result = await db.query(userQuery, [phone]);

        if (result && result.rows && result.rows.length > 0 && result.rows[0].is_approved) {
            const user = result.rows[0];
            return res.send(`id_list_message=t-ברוכים הבאים למערכת המשפחתית של ${user.tenant_name}.&read=t-להאזנה להודעות הקש 1. להקלטת הודעה חדשה הקש 2.=digits,yes,1,1,7,Number,no`);
        }

        if (result && result.rows && result.rows.length > 0 && !result.rows[0].is_approved) {
            return res.send('id_list_message=t-חשבונך ממתין לאישור מנהל המשפחה. אנא נסה שנית מאוחר יותר.&hangup=yes');
        }

        if (!digits) {
            return res.send('read=t-שלום. מספרכם אינו מוכר במערכת. אנא הקישו את קוד ההצטרפות המשפחתי שלכם ולאחריו סולמית.=digits,yes,6,6,10,Number,no');
        }

        const tenantCheck = await db.query('SELECT family_id, tenant_name FROM tenants WHERE join_code = $1 AND is_active = true', [digits]);
        
        if (!tenantCheck || tenantCheck.rows.length === 0) {
            return res.send('id_list_message=t-קוד משפחתי שגוי או לא פעיל.&hangup=yes');
        }

        const tenant = tenantCheck.rows[0];

        await db.query(
            'INSERT INTO users (family_id, phone_number, user_name, role, is_approved) VALUES ($1, $2, $3, $4, $5) ON CONFLICT DO NOTHING',
            [tenant.family_id, phone, 'משתמש חדש', 'user', false]
        );

        return res.send(`id_list_message=t-בקשתכם להצטרפות למשפחת ${tenant.tenant_name} נקלטה בהצלחה, ומועברת לאישור המנהל.&hangup=yes`);

    } catch (error) {
        console.error('Auth Route Internal Error:', error.message);
        const safeError = error.message.replace(/[^a-zA-Z0-9 ]/g, "");
        return res.send(`id_list_message=t-שגיאה פנימית במסד הנתונים ${safeError}.&hangup=yes`);
    }
});

// תופס שגיאות קצה
app.use((err, req, res, next) => {
    console.error('Global Error Handler Triggered:', err.stack);
    res.status(200).send('id_list_message=t-המערכת אותחלה בהצלחה. אנא חייגו שנית.&hangup=yes');
});

app.listen(PORT, () => console.log(`Server running on port ${PORT}`));