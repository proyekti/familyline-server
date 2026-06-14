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
        return res.send("id_list_message=t-שגיאה זמנית במערכת&go_to_folder=..");
    }
};

// ==========================================
// 🔐 כניסה למערכת ואימות (WHITELIST ONLY)
// ==========================================
app.get("/api/v1/auth", safe(async (req, res) => {
    const phone = p(req, "ApiPhone");
    if (!phone) return res.send("id_list_message=t-שגיאת זיהוי קו&hangup=yes");

    const userRes = await pool.query("SELECT * FROM users WHERE phone_number = $1 AND is_approved = true", [phone]);
    
    if (userRes.rows.length === 0) {
        return res.send("id_list_message=t-הגישה אינה מאושרת פנה למנהל המערכת&hangup=yes");
    }

    const user = userRes.rows[0];
    // איפוס מיקום זמני בכניסה לתפריט הראשי
    await pool.query("UPDATE users SET current_msg_index = 0 WHERE id = $1", [user.id]);

    return res.send(`read=t-ברוכים הבאים למערכת המשפחתית. להאזנה להודעות ועדכונים הקש 1. להשארת הודעה הקש 2. לאולפן הקלטות מיוחד הקש 3. לנתוני מערכת הקש 4. לניהול המערכת הקש 5=ApiDigits,yes,1,1,5,Number,no`);
}));

// ==========================================
// 📂 שלוחה 1 – הודעות שלי (תפריט פנימי)
// ==========================================
app.get("/api/v1/folder1", safe(async (req, res) => {
    return res.send(`read=t-להודעות חדשות בלבד הקש 1. לכל ההודעות הקש 2. להודעות ששלחתם הקש 3=ApiDigits,yes,1,1,3,Number,no`);
}));

// 📂 שלוחה 1 - השמעת ההודעות בפועל
app.get("/api/v1/listen", safe(async (req, res) => {
    const phone = p(req, "ApiPhone");
    const subFolder = p(req, "SubFolder"); // 1=חדשות, 2=כל ההודעות, 3=ששלחתי
    const action = p(req, "ApiDigits");
    const duration = parseInt(p(req, "ApiTime") || "0"); // זמן האזנה בשניות לשם סימון כנקרא

    const userRes = await pool.query("SELECT * FROM users WHERE phone_number = $1 AND is_approved = true", [phone]);
    if (!userRes.rows.length) return res.send("id_list_message=t-אין גישה&hangup=yes");
    const user = userRes.rows[0];

    // מנגנון סימון כנקרא/נשמע (אם שמע מעל 20 שניות או סיים הודעה)
    let lastMsgId = p(req, "LastMsgId");
    if (lastMsgId && (duration >= 20 || action === "1")) {
        await pool.query(`
            INSERT INTO message_reads (user_id, message_id) 
            VALUES ($1, $2) ON CONFLICT DO NOTHING
        `, [user.id, lastMsgId]);
    }

    let msgsQuery = "";
    let queryParams = [];

    if (subFolder === "1") {
        // 1.1 הודעות חדשות: מהישן לחדש, שלא שמע ושלא נמחקו אצלו, ושיועדו אליו (אישי, קבוצתי שהוא חבר בה, או לכל המשפחה)
        msgsQuery = `
            SELECT m.*, u.user_name as sender_name FROM messages m
            JOIN users u ON m.sender_id = u.id
            WHERE m.is_deleted = false
            AND m.id NOT IN (SELECT message_id FROM message_reads WHERE user_id = $1)
            AND (m.target_type = 'all' 
                 OR (m.target_type = 'user' AND m.target_id = $1)
                 OR (m.target_type = 'group' AND m.target_id IN (SELECT group_id FROM group_members WHERE user_id = $1))
            )
            ORDER BY m.id ASC`;
        queryParams = [user.id];
    } else if (subFolder === "2") {
        // 1.2 כל ההודעות: מהחדש לישן
        msgsQuery = `
            SELECT m.*, u.user_name as sender_name FROM messages m
            JOIN users u ON m.sender_id = u.id
            WHERE m.is_deleted = false
            AND m.id NOT IN (SELECT message_id FROM message_reads WHERE user_id = $1 AND is_hidden_locally = true)
            AND (m.target_type = 'all' 
                 OR (m.target_type = 'user' AND m.target_id = $1)
                 OR (m.target_type = 'group' AND m.target_id IN (SELECT group_id FROM group_members WHERE user_id = $1))
            )
            ORDER BY m.id DESC`;
        queryParams = [user.id];
    } else if (subFolder === "3") {
        // 1.3 הודעות ששלחתי
        msgsQuery = `
            SELECT m.*, 'אתה' as sender_name FROM messages m
            WHERE m.sender_id = $1 AND m.is_deleted = false
            ORDER BY m.id DESC`;
        queryParams = [user.id];
    } else {
        return res.send("go_to_folder=..");
    }

    const msgsRes = await pool.query(msgsQuery, queryParams);
    if (!msgsRes.rows.length) return res.send("id_list_message=t-אין הודעות בתיקייה זו&go_to_folder=..");

    let idx = user.current_msg_index;
    if (idx >= msgsRes.rows.length) idx = 0;

    const currentMsg = msgsRes.rows[idx];

    // טיפול במקשים (מחיקה, מעבר וכו')
    if (action === "7") { // מחיקה
        if (user.role === "admin" || currentMsg.sender_id === user.id || subFolder === "3") {
            // מחיקה גלובלית לכולם
            await pool.query("UPDATE messages SET is_deleted = true WHERE id = $1", [currentMsg.id]);
        } else {
            // מחיקה מקומית רק למשתמש הנוכחי
            await pool.query(`
                INSERT INTO message_reads (user_id, message_id, is_hidden_locally) 
                VALUES ($1, $2, true) 
                ON CONFLICT (user_id, message_id) DO UPDATE SET is_hidden_locally = true
            `, [user.id, currentMsg.id]);
        }
        return res.send("id_list_message=t-ההודעה נמחקה&go_to_folder=current");
    }

    if (action === "1") { // הודעה הבאה
        idx++;
        if (idx >= msgsRes.rows.length) idx = 0;
        await pool.query("UPDATE users SET current_msg_index = $1 WHERE id = $2", [idx, user.id]);
    }
    
    if (action === "2") { // הודעה קודמת
        idx--;
        if (idx < 0) idx = msgsRes.rows.length - 1;
        await pool.query("UPDATE users SET current_msg_index = $1 WHERE id = $2", [idx, user.id]);
    }

    // קריאת פרטי הודעה (תאריך ושם שולח)
    const formattedDate = new Date(currentMsg.created_at).toLocaleDateString('he-IL');
    return res.send(`id_list_message=t-הודעה מאת ${currentMsg.sender_name} מתאריך ${formattedDate}&id_list_message=f-${currentMsg.file_path}&read=t-להודעה הבאה הקש 1. להודעה הקודמת הקש 2. למחיקה הקש 7=ApiDigits,yes,1,1,7,Number,no&LastMsgId=${currentMsg.id}`);
}));

// ==========================================
// 📂 שלוחה 2 – השארת הודעה
// ==========================================
app.get("/api/v1/folder2", safe(async (req, res) => {
    return res.send(`read=t-להשארת הודעה לכל המשפחה הקש 1. להשארת הודעה אישית הקש 2=ApiDigits,yes,1,1,2,Number,no`);
}));

// תהליך בדיקת נמען להודעה אישית
app.get("/api/v1/private_target", safe(async (req, res) => {
    const digits = p(req, "ApiDigits");
    if (!digits) return res.send("read=t-נא להקיש את מספר הטלפון של הנמען לסיום הקש סולמית=ApiDigits,yes,9,12,10,Number,no");

    const targetRes = await pool.query("SELECT id, user_name FROM users WHERE phone_number = $1 AND is_approved = true", [digits]);
    if (!targetRes.rows.length) {
        return res.send("id_list_message=t-מספר הטלפון לא קיים במערכת&go_to_folder=current");
    }
    
    // מעבירים להקלטה עם מזהה היעד
    return res.send(`go_to_folder=/2/record?target_type=user&target_id=${targetRes.rows[0].id}`);
}));

// שמירת ההקלטה (הן לכל המשפחה והן לאישית)
app.get("/api/v1/record", safe(async (req, res) => {
    const phone = p(req, "ApiPhone");
    const fileUrl = p(req, "FileUrl");
    const targetType = p(req, "target_type") || "all"; // all, user, group
    const targetId = p(req, "target_id") ? parseInt(p(req, "target_id")) : null;

    const userRes = await pool.query("SELECT id FROM users WHERE phone_number = $1", [phone]);
    if (!userRes.rows.length) return res.send("id_list_message=t-שגיאת הרשאה&hangup=yes");
    
    if (!fileUrl) {
        return res.send("type=record&record_path=current&record_ok_go_to=current");
    }

    if (typeof fileUrl !== "string" || !fileUrl.startsWith("http")) {
        return res.send("id_list_message=t-שגיאה טכנית בהקלטה, נסה שנית&go_to_folder=..");
    }

    await pool.query(`
        INSERT INTO messages (sender_id, target_type, target_id, file_path, msg_type) 
        VALUES ($1, $2, $3, $4, 'regular')
    `, [userRes.rows[0].id, targetType, targetId, fileUrl]);

    return res.send("id_list_message=t-ההודעה הוקלטה ונשמרה בהצלחה&go_to_folder=..");
}));

// ==========================================
// 📂 שלוחה 4 – נתוני מערכת
// ==========================================
app.get("/api/v1/stats", safe(async (req, res) => {
    const phone = p(req, "ApiPhone");
    const userRes = await pool.query("SELECT id FROM users WHERE phone_number = $1", [phone]);
    const userId = userRes.rows[0].id;

    const totalUsers = await pool.query("SELECT COUNT(*) FROM users WHERE is_approved = true");
    const totalMsgs = await pool.query("SELECT COUNT(*) FROM messages WHERE is_deleted = false");
    const newMsgs = await pool.query(`
        SELECT COUNT(*) FROM messages m 
        WHERE m.is_deleted = false 
        AND m.id NOT IN (SELECT message_id FROM message_reads WHERE user_id = $1)
        AND (m.target_type = 'all' OR (m.target_type = 'user' AND m.target_id = $1))
    `, [userId]);

    return res.send(`id_list_message=t-במערכת רשומים ${totalUsers.rows[0].count} בני משפחה. יש לך ${newMsgs.rows[0].count} הודעות חדשות. סך הכל במערכת ${totalMsgs.rows[0].count} הודעות.&go_to_folder=..`);
}));

// ==========================================
// 📂 שלוחה 5 – ניהול מערכת (ADMIN ONLY)
// ==========================================
app.get("/api/v1/admin", safe(async (req, res) => {
    const phone = p(req, "ApiPhone");
    const userRes = await pool.query("SELECT role FROM users WHERE phone_number = $1", [phone]);
    
    if (!userRes.rows.length || userRes.rows[0].role !== "admin") {
        return res.send("id_list_message=t-שלוחה זו מיועדת למנהל המערכת בלבד&go_to_folder=..");
    }

    return res.send(`read=t-להוספת בן משפחה חדש הקש 1. להסרת בן משפחה הקש 2=ApiDigits,yes,1,1,2,Number,no`);
}));

app.get("/api/v1/admin_action", safe(async (req, res) => {
    const action = p(req, "AdminAction"); // 1=הוספה, 2=הסרה
    const digits = p(req, "ApiDigits");

    if (!digits) {
        return res.send(`read=t-נא להקיש את מספר הטלפון של בן המשפחה ובסיום סולמית=ApiDigits,yes,9,12,10,Number,no`);
    }

    if (action === "1") {
        await pool.query(`
            INSERT INTO users (family_id, phone_number, user_name, role, is_approved, current_msg_index)
            VALUES (1, $1, 'בן משפחה', 'user', true, 0)
            ON CONFLICT (phone_number) DO UPDATE SET is_approved = true
        `, [digits]);
        return res.send("id_list_message=t-בן המשפחה הוסף ואושר בהצלחה&go_to_folder=..");
    } else {
        await pool.query("UPDATE users SET is_approved = false WHERE phone_number = $1", [digits]);
        return res.send("id_list_message=t-המשתמש הוסר מהמערכת&go_to_folder=..");
    }
}));

// ==========================================
// 🚀 אתחול שרת והקמת בסיס הנתונים אוטומטית
// ==========================================
app.listen(PORT, async () => {
    console.log(`SERVER ONLINE ON PORT ${PORT}`);
    try {
        // יצירת מבנה הטבלאות המתאים לחלוטין לאפיון
        await pool.query(`
            CREATE TABLE IF NOT EXISTS tenants (
                family_id SERIAL PRIMARY KEY,
                tenant_name VARCHAR(100),
                join_code VARCHAR(20),
                is_active BOOLEAN DEFAULT true
            );
            CREATE TABLE IF NOT EXISTS users (
                id SERIAL PRIMARY KEY,
                family_id INTEGER,
                phone_number VARCHAR(20) UNIQUE,
                user_name VARCHAR(100),
                role VARCHAR(20) DEFAULT 'user',
                is_approved BOOLEAN DEFAULT false,
                current_msg_index INTEGER DEFAULT 0
            );
            CREATE TABLE IF NOT EXISTS messages (
                id SERIAL PRIMARY KEY,
                sender_id INTEGER,
                target_type VARCHAR(20) DEFAULT 'all', -- all, user, group
                target_id INTEGER,
                file_path TEXT,
                msg_type VARCHAR(20) DEFAULT 'regular',
                is_deleted BOOLEAN DEFAULT false,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );
            CREATE TABLE IF NOT EXISTS message_reads (
                user_id INTEGER,
                message_id INTEGER,
                is_hidden_locally BOOLEAN DEFAULT false,
                PRIMARY KEY (user_id, message_id)
            );
        `);
        console.log("🚀 DATABASE STRUCT VERIFIED & READY FOR ENTERPRISE ARCHITECTURE.");
    } catch (err) {
        console.error("❌ DATABASE INITIALIZATION FAILED:", err);
    }
});