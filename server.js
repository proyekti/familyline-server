const express = require('express');
const { Pool } = require('pg');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

// ==========================================
// 1. חיבור לבסיס הנתונים
// ==========================================
const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }
});

pool.on('error', (err) => {
    console.error('Unexpected error on database client', err.message);
});

app.set('db', pool);

app.use(express.urlencoded({ extended: true }));
app.use(express.json());

// קריטי: הגדרת הפלט כטקסט נקי עבור ימות המשיח
app.use((req, res, next) => {
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    next();
});

// ==========================================
// 2. MIDDLEWARE CONTEXT
// ==========================================
app.use((req, res, next) => {
    const apiPhone = req.query.ApiPhone || req.body.ApiPhone;
    const apiCallId = req.query.ApiCallId || req.body.ApiCallId;
    const apiExtension = req.query.ApiExtension || req.body.ApiExtension;

    req.telephony = {
        phone: apiPhone || '0500000000',
        callId: apiCallId || 'test_' + Date.now(),
        extension: apiExtension || '/'
    };
    next();
});

// ==========================================
// 3. ROUTING SYSTEM (ניתוב יציב ללא שגיאות)
// ==========================================

// שלוחת הניתוב הראשית שאליה פונה ה-ext.ini שלכם בשלוחת השורש
app.get('/api/v1/auth', (req, res) => {
    console.log(`Inbound call received from phone: ${req.telephony.phone}`);
    
    // מעבר חלק לשלוחה 1 במרכזייה מיד לאחר השמעת ההודעה, בלי לנתק ובלי שגיאות!
    return res.send('id_list_message=t-החיבור לשרת הצליח בהצלחה. מועברים לשלוחת ההאזנה.&go_to_folder=/1');
});

// טיפול גלובלי בשגיאות כדי למנוע קריסת HTTP 500
app.use((err, req, res, next) => {
    console.error('Global Error:', err.stack);
    res.status(200).send('id_list_message=t-שגיאה כללית בשרת האפליקציה.&go_to_folder=/');
});

app.listen(PORT, () => {
    console.log(`FamilyLine Server is running on port ${PORT}`);
});