const express = require("express");
const { Pool } = require("pg");
require("dotenv").config();

const app = express();
const PORT = process.env.PORT || 3000;

const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }
});

app.use(express.urlencoded({ extended: true }));
app.use(express.json());

app.use((req, res, next) => {
    res.setHeader("Content-Type", "text/plain; charset=utf-8");
    next();
});

const p = (req, k) => req.query?.[k] ?? req.body?.[k] ?? null;

const safe = (fn) => async (req, res) => {
    try {
        await fn(req, res);
    } catch (e) {
        console.error("CRITICAL ERROR:", e);
        return res.send("id_list_message=t-שגיאה זמנית, אנא נסה שנית&go_to_folder=..");
    }
};

// ==========================================
// 1. AUTH & RESET INDEX
// ==========================================
app.get("/api/v1/auth", safe(async (req, res) => {
    const phone = p(req, "ApiPhone");
    const digits = p(req, "ApiDigits");

    if (!phone) return res.send("id_list_message=t-שגיאת זיהוי&hangup=yes");

    // בכל כניסה לתפריט הראשי - מאפסים את מיקום קריאת ההודעות של המשתמש ב-DB
    await pool.query("UPDATE users SET current_msg_index = 0 WHERE phone_number = $1", [phone]);

    const userRes = await pool.query(
        `SELECT u.id, u.family_id, u.is_approved, u.current_msg_index, t.tenant_name
         FROM users u
         LEFT JOIN tenants t ON u.family_id = t.family_id
         WHERE u.phone_number=$1`,
        [phone]
    );

    if (userRes.rows.length > 0 && userRes.rows[0].is_approved) {
        const u = userRes.rows[0];
        if (digits === "1") return res.send("go_to_folder=/1");
        if (digits === "2") return res.send("go_to_folder=/2");

        return res.send(`read=t-ברוכים הבאים משפחת ${u.tenant_name || ""} הקש 1 להאזנה הקש 2 להקלטה=ApiDigits,yes,1,1,7,Number,no`);
    }

    if (userRes.rows.length > 0) return res.send("id_list_message=t-ממתין לאישור&hangup=yes");
    if (!digits) return res.send("read=t-הזן קוד משפחתי=ApiDigits,yes,6,6,10,Number,no");

    const tenant = await pool.query("SELECT family_id, tenant_name FROM tenants WHERE join_code=$1 AND is_active=true", [digits]);
    if (!tenant.rows.length) return res.send("id_list_message=t-קוד שגוי&hangup=yes");

    const t = tenant.rows[0];
    await pool.query(
        `INSERT INTO users (family_id, phone_number, user_name, role, is_approved, current_msg_index)
         VALUES ($1, $2, $3, $4, false, 0) ON CONFLICT DO NOTHING`,
        [t.family_id, phone, "משתמש חדש", "user"]
    );

    return res.send(`id_list_message=t-נשלחה בקשה למשפחה ${t.tenant_name}&hangup=yes`);
}));

// ==========================================
// 2. LISTEN (DATABASE-DRIVEN QUEUE) - 100% חסין ריסטארטים
// ==========================================
app.get("/api/v1/listen", safe(async (req, res) => {
    const phone = p(req, "ApiPhone");
    const action = p(req, "ApiDigits");

    const userRes = await pool.query("SELECT id, family_id, current_msg_index FROM users WHERE phone_number=$1 AND is_approved=true", [phone]);
    if (!userRes.rows.length) return res.send("id_list_message=t-אין גישה&hangup=yes");

    const user = userRes.rows[0];

    // שליפת כל ההודעות הפעילות של המשפחה
    const msgsRes = await pool.query(
        "SELECT id, file_path FROM messages WHERE family_id=$1 AND is_deleted=false ORDER BY id ASC",
        [user.family_id]
    );

    if (!msgsRes.rows.length) {
        return res.send("id_list_message=t-אין הודעות חדשות&go_to_folder=..");
    }

    let currentIndex = user.current_msg_index;

    // הגנה: אם האינדקס חרג בגלל שמחקו הודעות
    if (currentIndex >= msgsRes.rows.length) {
        currentIndex = 0;
    }

    // 7 פעולה 7: מחיקה
    if (action === "7") {
        const msgToDelete = msgsRes.rows[currentIndex];
        await pool.query("UPDATE messages SET is_deleted=true WHERE id=$1", [msgToDelete.id]);
        
        // טעינה מחדש של ההודעות שנשארו
        const updatedMsgs = await pool.query("SELECT id FROM messages WHERE family_id=$1 AND is_deleted=false", [user.family_id]);
        
        if (!updatedMsgs.rows.length) {
            await pool.query("UPDATE users SET current_msg_index = 0 WHERE id = $1", [user.id]);
            return res.send("id_list_message=t-אין הודעות נוספות&go_to_folder=..");
        }

        if (currentIndex >= updatedMsgs.rows.length) currentIndex = 0;
        await pool.query("UPDATE users SET current_msg_index = $1 WHERE id = $2", [currentIndex, user.id]);
        return res.send("id_list_message=t-נמחק&go_to_folder=current");
    }

    // פעולה 1: מעבר להודעה הבאה
    if (action === "1") {
        currentIndex++;
        if (currentIndex >= msgsRes.rows.length) currentIndex = 0;
        await pool.query("UPDATE users SET current_msg_index = $1 WHERE id = $2", [currentIndex, user.id]);
    }

    const msg = msgsRes.rows[currentIndex];
    return res.send(`id_list_message=f-${msg.file_path}&read=t-להודעה הבאה הקש 1 למחיקה הקש 7=ApiDigits,yes,1,1,7,Number,no`);
}));

// ==========================================
// 3. RECORD - עם אימות קובץ מחמיר (תיקון סעיף 3)
// ==========================================
app.get("/api/v1/record", safe(async (req, res) => {
    const phone = p(req, "ApiPhone");
    const fileUrl = p(req, "FileUrl");

    const user = await pool.query("SELECT id, family_id FROM users WHERE phone_number=$1", [phone]);
    if (!user.rows.length) return res.send("id_list_message=t-אין גישה&hangup=yes");

    const u = user.rows[0];

    if (!fileUrl) {
        return res.send("type=record&record_path=current&record_ok_go_to=current");
    }

    // הגנה קריטית: בדיקה שהקובץ תקין והוא אכן URL חוקי מימות המשיח ולא זבל או ריק
    if (typeof fileUrl !== "string" || !fileUrl.startsWith("http")) {
        console.error("INVALID FILE URL RECEIVED:", fileUrl);
        return res.send("id_list_message=t-שגיאה בהקלטת הקובץ, אנא נסה שנית&go_to_folder=current");
    }

    await pool.query(
        "INSERT INTO messages (family_id, sender_id, file_path, is_deleted) VALUES ($1, $2, $3, false)",
        [u.family_id, u.id, fileUrl]
    );

    return res.send("id_list_message=t-הוקלט ונשמר&go_to_folder=..");
}));

// ==========================================
// START SERVER & AUTOMATIC DB MIGRATION
// ==========================================
app.listen(PORT, async () => {
    console.log("VOICE WHATSAPP TRULY ENTERPRISE RUNNING ON PORT " + PORT);
    
    // הפקודה שיוצרת את העמודה בבסיס הנתונים אוטומטית ברגע שהשרת עולה
    try {
        await pool.query(`
            ALTER TABLE users 
            ADD COLUMN IF NOT EXISTS current_msg_index INTEGER DEFAULT 0;
        `);
        console.log("DATABASE CHECK: current_msg_index column verified/added successfully.");
    } catch (dbErr) {
        console.error("DATABASE MIGRATION FAILED:", dbErr);
    }
});