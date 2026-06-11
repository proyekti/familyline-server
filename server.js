const express = require('express');
const { Pool } = require('pg');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

// ==========================================
// 1. חיבור הרמטי למסד הנתונים
// ==========================================
const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }
});

pool.on('error', (err) => console.error('Database connection pool error:', err.message));
app.set('db', pool);

app.use(express.urlencoded({ extended: true }));
app.use(express.json());

// חובה לפי מסמך ימות המשיח: החזרת טקסט נקי בלבד
app.use((req, res, next) => {
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    next();
});

// ==========================================
// 2. הראוטר הראשי - מותאם במאה אחוז ל-API של ימות
// ==========================================

// שינוי קריטי: השרת מקשיב ישירות בנתיב השורש כדי למנוע טעויות ניתוב של המרכזייה
app.all('/', async (req, res) => {
    const db = req.app.get('db');
    
    // חילוץ פרמטרים רשמיים ומדויקים לפי מסמך ה-API שצירפת
    const phone = req.query.ApiPhone || req.body.ApiPhone || '0500000000';
    const apiDigits = req.query.ApiDigits || req.body.ApiDigits || null;

    try {
        // בדיקה האם המשתמש כבר קיים ומאושר ב-Database
        const userQuery = `
            SELECT u.id as user_id, u.family_id, u.is_approved, t.tenant_name 
            FROM users u
            JOIN tenants t ON u.family_id = t.family_id
            WHERE u.phone_number = $1 AND t.is_active = TRUE
        `;
        const result = await db.query(userQuery, [phone]);

        // תרחיש 1: המשתמש קיים ומאושר
        if (result && result.rows && result.rows.length > 0 && result.rows[0].is_approved) {
            const user = result.rows[0];
            return res.send(`id_list_message=t-ברוכים הבאים למערכת המשפחתית של ${user.tenant_name} לשמיעת הודעות הקש 1 להקלטת הודעה חדשה הקש 2&read=t-נא להקיש בחירה ולאחריה סולמית=ApiDigits,yes,1,1,7,Number,no`);
        }

        // תרחיש 2: המשתמש רשום אך ממתין לאישור מנהל
        if (result && result.rows && result.rows.length > 0 && !result.rows[0].is_approved) {
            return res.send('id_list_message=t-חשבונך עדיין ממתין לאישור מנהל המשפחה אנא נסה שנית מאוחר יותר&go_to_folder=current');
        }

        // תרחיש 3: משתמש חדש - שלב א': המערכת מבקשת קוד הצטרפות
        if (!apiDigits) {
            return res.send('read=t-שלום מספרכם אינו מוכר במערכת אנא הקישו את קוד ההצטרפות המשפחתי שלכם ולאחריו סולמית=ApiDigits,yes,6,6,10,Number,no');
        }

        // תרחיש 4: משתמש חדש - שלב ב': המערכת בודקת את הקוד שהוקש (הגיע בתוך ApiDigits)
        const tenantCheck = await db.query('SELECT family_id, tenant_name FROM tenants WHERE join_code = $1 AND is_active = true', [apiDigits]);
        
        // אם הקוד שגוי
        if (!tenantCheck || tenantCheck.rows.length === 0) {
            return res.send('id_list_message=t-קוד משפחתי שגוי או לא פעיל נסו לחייג שוב בשנית&go_to_folder=current');
        }

        const tenant = tenantCheck.rows[0];

        // הכנסת המשתמש החדש לטבלה במצב ממתין
        await db.query(
            'INSERT INTO users (family_id, phone_number, user_name, role, is_approved) VALUES ($1, $2, $3, $4, $5) ON CONFLICT DO NOTHING',
            [tenant.family_id, phone, 'משתמש חדש', 'user', false]
        );

        return res.send(`id_list_message=t-בקשתכם להצטרפות למשפחת ${tenant.tenant_name} נקלטה בהצלחה ומועברת לאישור המנהל המערכת תתנתק כעת&hangup=yes`);

    } catch (error) {
        console.error('Core Logic Error:', error.message);
        return res.send('id_list_message=t-תקלה זמנית בתקשורת מול מסד הנתונים אנא נסו לחייג שוב מאוחר יותר&go_to_folder=current');
    }
});

// פונקציית הגנה אולטימטיבית למניעת נפילת השרת
app.use((err, req, res, next) => {
    console.error('Protected Global Crash:', err.stack);
    res.status(200).send('id_list_message=t-המערכת מתרעננת אנא המתינו שניה וחייגו שוב&go_to_folder=current');
});

app.listen(PORT, () => console.log(`FamilyLine Engine Online on port ${PORT}`));