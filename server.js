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

// פונקציית קסם: בונה את הטבלאות אוטומטית מהטרמינל/שרת בריצה הראשונה!
async function initDatabase() {
    try {
        console.log('Starting DB migration...');
        
        // יצירת טבלת משפחות
        await pool.query(`
            CREATE TABLE IF NOT EXISTS tenants (
                family_id SERIAL PRIMARY KEY,
                tenant_name VARCHAR(100) NOT NULL,
                join_code VARCHAR(20) UNIQUE NOT NULL,
                is_active BOOLEAN DEFAULT TRUE,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );
        `);

        // יצירת טבלת משתמשים
        await pool.query(`
            CREATE TABLE IF NOT EXISTS users (
                id SERIAL PRIMARY KEY,
                family_id INT REFERENCES tenants(family_id),
                phone_number VARCHAR(20) UNIQUE NOT NULL,
                user_name VARCHAR(100),
                role VARCHAR(20) DEFAULT 'user',
                is_approved BOOLEAN DEFAULT FALSE,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );
        `);

        // יצירת טבלת הודעות
        await pool.query(`
            CREATE TABLE IF NOT EXISTS messages (
                id SERIAL PRIMARY KEY,
                family_id INT REFERENCES tenants(family_id),
                sender_id INT REFERENCES users(id),
                file_path VARCHAR(255) NOT NULL,
                is_deleted BOOLEAN DEFAULT FALSE,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );
        `);

        // הכנסת משפחת בדיקה ראשונית
        await pool.query(`
            INSERT INTO tenants (tenant_name, join_code, is_active) 
            VALUES ('משפחת שפירא', '102030', true)
            ON CONFLICT (join_code) DO NOTHING;
        `);

        console.log('DB Migration completed successfully! All tables ready.');
    } catch (err) {
        console.error('Error during DB Migration:', err.message);
    }
}

// הרצת האתחול אוטומטית
initDatabase();

app.set('db', pool);

app.use(express.urlencoded({ extended: true }));
app.use(express.json());

app.use((req, res, next) => {
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    next();
});

// ==========================================
// 2. MIDDLEWARE CONTEXT
// ==========================================
app.use((req, res, next) => {
    const apiPhone = req.query.ApiPhone || req.body.ApiPhone || '0500000000';
    const apiCallId = req.query.ApiCallId || req.body.ApiCallId || 'test_' + Date.now();
    const digits = req.query.digits || req.body.digits || null;

    req.telephony = {
        phone: apiPhone,
        callId: apiCallId,
        digits: digits
    };
    next();
});

// ==========================================
// 3. ROUTING SYSTEM
// ==========================================

app.get('/api/v1/auth', async (req, res) => {
    const db = req.app.get('db');
    const { phone, digits } = req.telephony;

    try {
        const userQuery = `
            SELECT u.id as user_id, u.family_id, u.is_approved, t.tenant_name 
            FROM users u
            JOIN tenants t ON u.family_id = t.family_id
            WHERE u.phone_number = $1 AND t.is_active = TRUE
        `;
        const result = await db.query(userQuery, [phone]);

        if (result.rows.length > 0 && result.rows[0].is_approved) {
            const user = result.rows[0];
            return res.send(`id_list_message=t-ברוכים הבאים למערכת המשפחתית של ${user.tenant_name}.&read=t-להאזנה להודעות הקש 1. להקלטת הודעה חדשה הקש 2.=digits,yes,1,1,7,Number,no`);
        }

        if (result.rows.length > 0 && !result.rows[0].is_approved) {
            return res.send('id_list_message=t-חשבונך ממתין לאישור מנהל המשפחה. אנא נסה שנית מאוחר יותר.&hangup=yes');
        }

        if (!digits) {
            return res.send('read=t-שלום. מספרכם אינו מוכר במערכת. אנא הקישו את קוד ההצטרפות המשפחתי שלכם ולאחריו סולמית.=digits,yes,6,6,10,Number,no');
        }

        const tenantCheck = await db.query('SELECT family_id, tenant_name FROM tenants WHERE join_code = $1 AND is_active = true', [digits]);
        
        if (tenantCheck.rows.length === 0) {
            return res.send('id_list_message=t-קוד משפחתי שגוי או לא פעיל.&hangup=yes');
        }

        const tenant = tenantCheck.rows[0];

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

app.use((err, req, res, next) => {
    console.error('Global Error:', err.stack);
    res.status(200).send('id_list_message=t-אירעה שגיאה כללית זמנית.&hangup=yes');
});

app.listen(PORT, () => console.log(`Server running on port ${PORT}`));