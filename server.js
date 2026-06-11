const express = require('express');
const { Pool } = require('pg');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

// ==========================================
// 1. חיבור לבסיס הנתונים עם מעקף חסימת סינון
// ==========================================
const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    // שינוי קריטי עבור נטפרי / סינונים: ביטול חובת תעודת השרת המקומית
    ssl: { rejectUnauthorized: false } 
});

// מניעת קריסת השרת הגלובלית במקרה של שגיאות חיבור מהסינון
pool.on('error', (err) => {
    console.error('Unexpected error on idle database client', err.message);
});

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
const y_telephonyContext = async (req, res, next) => {
    const apiPhone = req.query.ApiPhone || req.body.ApiPhone;
    const apiCallId = req.query.ApiCallId || req.body.ApiCallId;
    const apiExtension = req.query.ApiExtension || req.body.ApiExtension;

    // הגנה: ימות המשיח לפעמים מפספסת בבקשה הראשונה, ניצר מזהה זמני כדי שלא יקרוס
    req.telephony = {
        phone: apiPhone || '0500000000',
        callId: apiCallId || 'temp_' + Date.now(),
        extension: apiExtension || '/'
    };

    next();
};

app.use(y_telephonyContext);

// ==========================================
// 3. ROUTING SYSTEM (עטוף ב-Try/Catch הרמטי)
// ==========================================

app.get('/api/v1/auth', async (req, res) => {
    const db = req.app.get('db');
    const { phone } = req.telephony;
    const digits = req.query.digits;

    try {
        // בדיקה חסינת קריסה מול ה-DB
        const checkUser = await db.query('SELECT family_id FROM users WHERE phone_number = $1 AND is_approved = true', [phone]);
        
        if (checkUser && checkUser.rows && checkUser.rows.length > 0) {
            return res.send(`id_list_message=t-ברוכים הבאים למערכת.&go_to_folder=/1`);
        }

        if (!digits) {
            return res.send('read=t-ברוכים הבאים. אנא הקישו את קוד ההצטרפות המשפחתי שלכם ולאחריו סולמית.=digits,yes,6,6,10,Number,no');
        }

        const tenantCheck = await db.query('SELECT family_id, tenant_name FROM tenants WHERE join_code = $1 AND is_active = true', [digits]);
        
        if (!tenantCheck || tenantCheck.rows.length === 0) {
            return res.send('id_list_message=t-קוד שגוי או לא פעיל.&hangup=yes');
        }

        const tenant = tenantCheck.rows[0];

        await db.query(
            'INSERT INTO users (family_id, phone_number, user_name, role, is_approved) VALUES ($1, $2, $3, $4, $5) ON CONFLICT DO NOTHING',
            [tenant.family_id, phone, 'משתמש חדש', 'user', false]
        );

        return res.send(`id_list_message=t-בקשתכם להצטרפות ל${tenant.tenant_name} נקלטה.&hangup=yes`);

    } catch (error) {
        // אם הסינון חוסם את ה-DB, השרת לא יקרוס! הוא יחזיר פקודה חלופית לימות המשיח
        console.error('Critical DB Blocked by Filter:', error.message);
        return res.send('read=t-חיבור הנתונים חסום זמנית. אנא נסו להקיש את קוד ההצטרפות שלכם כעת.=digits,yes,6,6,10,Number,no');
    }
});

// טיפול בשגיאות קצה
app.use((err, req, res, next) => {
    res.status(200).send('id_list_message=t-המערכת חווה עומס זמני. אנא נסו שוב.');
});

app.listen(PORT, () => {
    console.log(`Server is running`);
});