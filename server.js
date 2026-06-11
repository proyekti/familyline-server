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
    ssl: { rejectUnauthorized: false }
});

pool.connect((err, client, release) => {
    if (err) {
        return console.error('Error acquiring client', err.stack);
    }
    console.log('Successfully connected to PostgreSQL Database on Render.');
    release();
});

app.set('db', pool);

app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use((req, res, next) => {
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    next();
});

// ==========================================
// 2. MIDDLEWARES & CONTEXT
// ==========================================

const y_telephonyContext = async (req, res, next) => {
    const apiPhone = req.query.ApiPhone || req.body.ApiPhone;
    const apiCallId = req.query.ApiCallId || req.body.ApiCallId;
    const apiExtension = req.query.ApiExtension || req.body.ApiExtension;

    if (!apiCallId) {
        return res.send('id_list_message=t-שגיאת מערכת. שיחה לא מזוהה.');
    }

    req.telephony = {
        phone: apiPhone || 'חסוי',
        callId: apiCallId,
        extension: apiExtension
    };

    next();
};

const requireTenant = async (req, res, next) => {
    const db = req.app.get('db');
    const { phone } = req.telephony;

    try {
        const userQuery = `
            SELECT u.id as user_id, u.family_id, u.role, u.is_approved, t.tenant_name 
            FROM users u
            JOIN tenants t ON u.family_id = t.family_id
            WHERE u.phone_number = $1 AND t.is_active = TRUE
        `;
        const result = await db.query(userQuery, [phone]);

        if (result.rows.length === 0) {
            return res.send('id_list_message=t-המספר אינו מוכר במערכת.&go_to_folder=/');
        }

        const user = result.rows[0];

        if (!user.is_approved) {
            return res.send('id_list_message=t-חשבונך ממתין לאישור מנהל המערכת.&hangup=yes');
        }

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

// הפעלת ה-Context הגלובלי
app.use(y_telephonyContext);

// ==========================================
// 3. ROUTING SYSTEM
// ==========================================

// שלוחת אימות (ללא requireTenant)
app.get('/api/v1/auth', async (req, res) => {
    const db = req.app.get('db');
    const { phone } = req.telephony;
    const digits = req.query.digits;

    try {
        const checkUser = await db.query('SELECT family_id FROM users WHERE phone_number = $1 AND is_approved = true', [phone]);
        
        if (checkUser.rows.length > 0) {
            return res.send(`id_list_message=t-ברוכים הבאים למערכת.&go_to_folder=/1`);
        }

        if (!digits) {
            return res.send('read=t-המספר אינו מוכר במערכת. אנא הקישו את קוד ההצטרפות המשפחתי שלכם ולאחריו סולמית.=digits,yes,6,6,10,Number,no');
        }

        const tenantCheck = await db.query('SELECT family_id, tenant_name FROM tenants WHERE join_code = $1 AND is_active = true', [digits]);
        
        if (tenantCheck.rows.length === 0) {
            return res.send('id_list_message=t-קוד שגוי או לא פעיל.&hangup=yes');
        }

        const tenant = tenantCheck.rows[0];

        await db.query(
            'INSERT INTO users (family_id, phone_number, user_name, role, is_approved) VALUES ($1, $2, $3, $4, $5) ON CONFLICT DO NOTHING',
            [tenant.family_id, phone, 'משתמש חדש', 'user', false]
        );

        return res.send(`id_list_message=t-בקשתכם להצטרפות ל${tenant.tenant_name} נקלטה ומועברת לאישור המנהל.&hangup=yes`);

    } catch (error) {
        console.error('Auth Route Error:', error);
        return res.send('id_list_message=t-שגיאה זמנית בשרת האימות.');
    }
});

// שלוחות מוגנות (עם requireTenant)
app.get('/api/v1/listen', requireTenant, async (req, res) => {
    return res.send(`id_list_message=t-נכנסתם לשלוחת ההאזנה של ${req.tenant.familyName}.`);
});

app.get('/api/v1/send', requireTenant, async (req, res) => {
    return res.send('id_list_message=t-שלוחת שליחת הודעות בבנייה.');
});

app.get('/api/v1/tzintuk', requireTenant, async (req, res) => {
    return res.send('id_list_message=t-שלוחת צינתוקים.');
});

app.use((err, req, res, next) => {
    console.error('Global Error Handler:', err.stack);
    res.status(500).send('id_list_message=t-שגיאה כללית בשרת האפליקציה.');
});

app.listen(PORT, () => {
    console.log(`FamilyLine Server is running on port ${PORT}`);
});