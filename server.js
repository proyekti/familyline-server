const express = require("express");
const { Pool } = require("pg");
require("dotenv").config();

const app = express();
const PORT = process.env.PORT || 10000;

const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }
});

app.use(express.urlencoded({ extended: true }));
app.use(express.json());

// הגדרת תגובת טקסט נקי עבור ימות המשיח
app.use((req, res, next) => {
    res.setHeader("Content-Type", "text/plain; charset=utf-8");
    next();
});

// פונקציית עזר לקבלת פרמטרים מכל סוג בקשה
const p = (req, k) => req.query?.[k] ?? req.body?.[k] ?? null;

// פונקציית עזר לטיפול בטוח בשגיאות מבלי שהשרת יקרוס
const safe = (fn) => async (req, res) => {
    try {
        await fn(req, res);
    } catch (e) {
        console.error("CRITICAL ERROR:", e);
        return res.send("id_list_message=t-שגיאה זמנית במערכת&go_to_folder=..");
    }
};

// ==========================================
// כניסה למערכת ואימות (WHITELIST ONLY)
// ==========================================
app.get("/api/v1/auth", safe(async (req, res) => {
    const phone = p(req, "ApiPhone");
    if (!phone) return res.send("id_list_message=t-שגיאת זיהוי קו&hangup=yes");

    const userRes = await pool.query("SELECT * FROM users WHERE phone_number = $1 AND is_approved = true", [phone]);
    
    if (userRes.rows.length === 0) {
        return res.send("id_list_message=t-הגישה אינה מאושרת פנה למנהל המערכת&hangup=yes");
    }

    const user = userRes.rows[0];
    await pool.query("UPDATE users SET current_msg_index = 0 WHERE id = $1", [user.id]);

    return res.send(`read=t-ברוכים הבאים למערכת המשפחתית. להאזנה להודעות הקש 1. להשארת הודעה הקש 2. לאולפן הקלטות מיוחד הקש 3. לנתוני מערכת הקש 4. לניהול המערכת למנהל בלבד הקש 5. ליצירה וניהול קבוצות משפחתיות הקש 6=ApiDigits,yes,1,1,6,Number,no`);
}));

// ==========================================
// שלוחה 1 – הודעות שלי (מאחד קבוצות, משפחה ואישי)
// ==========================================
app.get("/api/v1/folder1", safe(async (req, res) => {
    return res.send(`read=t-להודעות חדשות בלבד הקש 1. לכל ההודעות הקש 2. להודעות ששלחתם הקש 3=ApiDigits,yes,1,1,3,Number,no`);
}));

app.get("/api/v1/listen", safe(async (req, res) => {
    const phone = p(req, "ApiPhone");
    const subFolder = p(req, "SubFolder") || p(req, "ApiExtension"); 
    const action = p(req, "ApiDigits");
    const duration = parseInt(p(req, "ApiTime") || "0"); 

    const userRes = await pool.query("SELECT * FROM users WHERE phone_number = $1 AND is_approved = true", [phone]);
    if (!userRes.rows.length) return res.send("id_list_message=t-אין גישה&hangup=yes");
    const user = userRes.rows[0];

    let lastMsgId = p(req, "LastMsgId");
    if (lastMsgId && (duration >= 20 || action === "1")) {
        await pool.query(`INSERT INTO message_reads (user_id, message_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`, [user.id, lastMsgId]);
    }

    let msgsQuery = "";
    let queryParams = [];

    if (subFolder === "1" || subFolder === "1.1") {
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
    } else if (subFolder === "2" || subFolder === "1.2") {
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
    } else if (subFolder === "3" || subFolder === "1.3") {
        msgsQuery = `
            SELECT m.*, 'אתה' as sender_name FROM messages m
            WHERE m.sender_id = $1 AND m.is_deleted = false
            ORDER BY m.id DESC`;
        queryParams = [user.id];
    }

    const msgsRes = await pool.query(msgsQuery, queryParams);
    if (!msgsRes.rows.length) return res.send("id_list_message=t-אין הודעות בתיקייה זו&go_to_folder=..");

    let idx = user.current_msg_index;
    if (idx >= msgsRes.rows.length) idx = 0;
    const currentMsg = msgsRes.rows[idx];

    if (action === "7") { 
        if (user.role === "admin" || currentMsg.sender_id === user.id || subFolder === "3") {
            await pool.query("UPDATE messages SET is_deleted = true WHERE id = $1", [currentMsg.id]);
        } else {
            await pool.query(`INSERT INTO message_reads (user_id, message_id, is_hidden_locally) VALUES ($1, $2, true) ON CONFLICT (user_id, message_id) DO UPDATE SET is_hidden_locally = true`, [user.id, currentMsg.id]);
        }
        return res.send("id_list_message=t-ההודעה נמחקה&go_to_folder=current");
    }

    if (action === "1") { 
        idx++; if (idx >= msgsRes.rows.length) idx = 0;
        await pool.query("UPDATE users SET current_msg_index = $1 WHERE id = $2", [idx, user.id]);
    }
    if (action === "2") { 
        idx--; if (idx < 0) idx = msgsRes.rows.length - 1;
        await pool.query("UPDATE users SET current_msg_index = $1 WHERE id = $2", [idx, user.id]);
    }

    const formattedDate = new Date(currentMsg.created_at).toLocaleDateString('he-IL');
    return res.send(`id_list_message=t-הודעה מאת ${currentMsg.sender_name} מתאריך ${formattedDate}&id_list_message=f-${currentMsg.file_path}&read=t-להודעה הבאה הקש 1. להודעה הקודמת הקש 2. למחיקה הקש 7=ApiDigits,yes,1,1,7,Number,no&LastMsgId=${currentMsg.id}&SubFolder=${subFolder}`);
}));

// ==========================================
// שלוחה 2 – השארת הודעה
// ==========================================
app.get("/api/v1/folder2", safe(async (req, res) => {
    return res.send(`read=t-להשארת הודעה לכל המשפחה הקש 1. להשארת הודעה לקבוצה הקש 2. להשארת הודעה אישית הקש 3=ApiDigits,yes,1,1,3,Number,no`);
}));

app.get("/api/v1/choose_group", safe(async (req, res) => {
    const phone = p(req, "ApiPhone");
    const digits = p(req, "ApiDigits");

    const userRes = await pool.query("SELECT id FROM users WHERE phone_number = $1", [phone]);
    const userId = userRes.rows[0].id;

    const groupsRes = await pool.query(`
        SELECT g.group_id, g.group_name FROM groups g
        JOIN group_members gm ON g.group_id = gm.group_id
        WHERE gm.user_id = $1
    `, [userId]);

    if (!groupsRes.rows.length) {
        return res.send("id_list_message=t-אינך חבר באף קבוצה כרגע&go_to_folder=..");
    }

    if (digits) {
        const selectedIdx = parseInt(digits) - 1;
        if (selectedIdx >= 0 && selectedIdx < groupsRes.rows.length) {
            const group = groupsRes.rows[selectedIdx];
            return res.send(`go_to_folder=record?target_type=group&target_id=${group.group_id}`);
        }
        return res.send("id_list_message=t-בחירה שגויה&go_to_folder=current");
    }

    let speech = "לבחירת קבוצה: ";
    groupsRes.rows.forEach((g, index) => { speech += `לקבוצת ${g.group_name} הקש ${index + 1}. `; });
    return res.send(`read=t-${speech}=ApiDigits,yes,1,1,${groupsRes.rows.length},Number,no`);
}));

app.get("/api/v1/private_target", safe(async (req, res) => {
    const digits = p(req, "ApiDigits");
    if (!digits) return res.send("read=t-נא להקיש את מספר הטלפון של הנמען לסיום הקש סולמית=ApiDigits,yes,9,12,10,Number,no");

    const targetRes = await pool.query("SELECT id FROM users WHERE phone_number = $1 AND is_approved = true", [digits]);
    if (!targetRes.rows.length) return res.send("id_list_message=t-מספר הטלפון לא קיים במערכת&go_to_folder=current");
    
    return res.send(`go_to_folder=record?target_type=user&target_id=${targetRes.rows[0].id}`);
}));

app.get("/api/v1/record", safe(async (req, res) => {
    const phone = p(req, "ApiPhone");
    const fileUrl = p(req, "FileUrl");
    const targetType = p(req, "target_type") || "all"; 
    const targetId = p(req, "target_id") ? parseInt(p(req, "target_id")) : null;

    const userRes = await pool.query("SELECT id FROM users WHERE phone_number = $1", [phone]);
    if (!userRes.rows.length) return res.send("id_list_message=t-שגיאת הרשאה&hangup=yes");
    
    if (!fileUrl) {
        return res.send("type=record&record_path=current&record_ok_go_to=current");
    }

    await pool.query(`INSERT INTO messages (sender_id, target_type, target_id, file_path, msg_type) VALUES ($1, $2, $3, $4, 'regular')`, [userRes.rows[0].id, targetType, targetId, fileUrl]);
    return res.send("id_list_message=t-ההודעה הוקלטה ונשמרה בהצלחה&go_to_folder=..");
}));

// ==========================================
// שלוחה 3 – אולפן הקלטות מיוחד
// ==========================================
app.get("/api/v1/studio", safe(async (req, res) => {
    return res.send("id_list_message=t-ברוכים הבאים לאולפן ההקלטות המיוחד. פונקציה זו בפיתוח ותהיה זמינה בקרוב&go_to_folder=..");
}));

// ==========================================
// שלוחה 4 – נתוני מערכת
// ==========================================
app.get("/api/v1/stats", safe(async (req, res) => {
    const phone = p(req, "ApiPhone");
    const userRes = await pool.query("SELECT id FROM users WHERE phone_number = $1", [phone]);
    const userId = userRes.rows[0].id;

    const totalUsers = await pool.query("SELECT COUNT(*) FROM users WHERE is_approved = true");
    const totalMsgs = await pool.query("SELECT COUNT(*) FROM messages WHERE is_deleted = false");
    const newMsgs = await pool.query(`
        SELECT COUNT(*) FROM messages m WHERE m.is_deleted = false AND m.id NOT IN (SELECT message_id FROM message_reads WHERE user_id = $1)
        AND (m.target_type = 'all' OR (m.target_type = 'user' AND m.target_id = $1) OR (m.target_type = 'group' AND m.target_id IN (SELECT group_id FROM group_members WHERE user_id = $1)))
    `, [userId]);

    return res.send(`id_list_message=t-במערכת רשומים ${totalUsers.rows[0].count} בני משפחה. יש לך ${newMsgs.rows[0].count} הודעות חדשות. סך הכל במערכת ${totalMsgs.rows[0].count} הודעות.&go_to_folder=..`);
}));

// ==========================================
// שלוחה 5 – ניהול מערכת (מנהל בלבד)
// ==========================================
app.get("/api/v1/admin", safe(async (req, res) => {
    const phone = p(req, "ApiPhone");
    const userRes = await pool.query("SELECT role FROM users WHERE phone_number = $1", [phone]);
    if (!userRes.rows.length || userRes.rows[0].role !== "admin") return res.send("id_list_message=t-שלוחה זו מיועדת למנהל בלבד&go_to_folder=..");
    return res.send(`read=t-להוספת בן משפחה חדש הקש 1. להסרת בן משפחה הקש 2=ApiDigits,yes,1,1,2,Number,no`);
}));

app.get("/api/v1/admin_action", safe(async (req, res) => {
    const action = p(req, "AdminAction") || p(req, "ApiDigits"); 
    const digits = p(req, "MemberPhone");

    if (!digits) {
        return res.send(`read=t-נא להקיש את מספר הטלפון של בן המשפחה ובסיום סולמית=ApiDigits,yes,9,12,10,Number,no&AdminAction=${action}`);
    }

    if (action === "1") {
        await pool.query(`INSERT INTO users (family_id, phone_number, user_name, role, is_approved) VALUES (1, $1, 'בן משפחה', 'user', true) ON CONFLICT (phone_number) DO UPDATE SET is_approved = true`, [digits]);
        return res.send("id_list_message=t-בן המשפחה הוסף ואושר בהצלחה&go_to_folder=..");
    } else {
        await pool.query("UPDATE users SET is_approved = false WHERE phone_number = $1", [digits]);
        return res.send("id_list_message=t-המשתמש הוסר מהמערכת&go_to_folder=..");
    }
}));

// ==========================================
// שלוחה 6 – יצירה וניהול קבוצות (לכל משתמש)
// ==========================================
app.get("/api/v1/manage_groups", safe(async (req, res) => {
    return res.send(`read=t-ליצירת קבוצה חדשה הקש 1. להוספת חבר לקבוצה קיימת הקש 2. להסרת חבר מקבוצה הקש 3=ApiDigits,yes,1,1,3,Number,no`);
}));

app.get("/api/v1/create_group", safe(async (req, res) => {
    const phone = p(req, "ApiPhone");
    const fileUrl = p(req, "FileUrl");

    const userRes = await pool.query("SELECT id FROM users WHERE phone_number = $1", [phone]);
    const userId = userRes.rows[0].id;

    if (!fileUrl) {
        return res.send("read=t-אנא הקלט את שם הקבוצה לאחר הצליל ובסיום הקש סולמית=ApiDigits,yes,1,1,1,Number,no&type=record&record_path=current&record_ok_go_to=current");
    }

    const groupRes = await pool.query(`INSERT INTO groups (family_id, group_name, created_by) VALUES (1, 'קבוצה מוקלטת', $1) RETURNING group_id`, [userId]);
    await pool.query(`INSERT INTO group_members (group_id, user_id) VALUES ($1, $2)`, [groupRes.rows[0].group_id, userId]);

    return res.send("id_list_message=t-הקבוצה נוצרה בהצלחה. כעת תוכל להוסיף לה חברים.&go_to_folder=..");
}));

app.get("/api/v1/group_member_action", safe(async (req, res) => {
    const phone = p(req, "ApiPhone");
    const action = p(req, "GroupAction"); 
    const digits = p(req, "ApiDigits"); 
    const groupId = p(req, "GroupId");

    const userRes = await pool.query("SELECT id FROM users WHERE phone_number = $1", [phone]);
    const userId = userRes.rows[0].id;

    if (!groupId) {
        const groupsRes = await pool.query(`SELECT g.group_id, g.group_name FROM groups g WHERE g.created_by = $1`, [userId]);
        if (!groupsRes.rows.length) return res.send("id_list_message=t-אין קבוצות בבעלותך&go_to_folder=..");
        
        if (digits) {
            const selectedIdx = parseInt(digits) - 1;
            if (selectedIdx >= 0 && selectedIdx < groupsRes.rows.length) {
                return res.send(`go_to_folder=current?GroupId=${groupsRes.rows[selectedIdx].group_id}&GroupAction=${action}`);
            }
            return res.send("id_list_message=t-בחירה שגויה&go_to_folder=current");
        }

        let speech = "בחר קבוצה לניהול: ";
        groupsRes.rows.forEach((g, idx) => { speech += `עבור ${g.group_name} הקש ${idx + 1}. `; });
        return res.send(`read=t-${speech}=ApiDigits,yes,1,1,${groupsRes.rows.length},Number,no`);
    }

    if (groupId && !digits) {
        return res.send(`read=t-נא להקיש את מספר הטלפון של בן המשפחה ובסיום סולמית=ApiDigits,yes,9,12,10,Number,no&GroupId=${groupId}&GroupAction=${action}`);
    }

    const targetUserRes = await pool.query("SELECT id FROM users WHERE phone_number = $1 AND is_approved = true", [digits]);
    if (!targetUserRes.rows.length) return res.send("id_list_message=t-מספר הטלפון לא רשום במערכת&go_to_folder=..");
    const targetUserId = targetUserRes.rows[0].id;

    if (action === "2") {
        await pool.query(`INSERT INTO group_members (group_id, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`, [groupId, targetUserId]);
        return res.send("id_list_message=t-החבר הוסף לקבוצה בהצלחה&go_to_folder=..");
    } else {
        await pool.query(`DELETE FROM group_members WHERE group_id = $1 AND user_id = $2`, [groupId, targetUserId]);
        return res.send("id_list_message=t-החבר הוסר מהקבוצה&go_to_folder=..");
    }
}));

// הפעלת השרת תוך הגדרת הכתובת המתאימה ל-Render
app.listen(PORT, "0.0.0.0", async () => {
    console.log(`SERVER ONLINE ON PORT ${PORT}`);
    try {
        await pool.query(`
            CREATE TABLE IF NOT EXISTS tenants (family_id SERIAL PRIMARY KEY, tenant_name VARCHAR(100), join_code VARCHAR(20), is_active BOOLEAN DEFAULT true);
            CREATE TABLE IF NOT EXISTS users (id SERIAL PRIMARY KEY, family_id INTEGER, phone_number VARCHAR(20) UNIQUE, user_name VARCHAR(100), role VARCHAR(20) DEFAULT 'user', is_approved BOOLEAN DEFAULT false, current_msg_index INTEGER DEFAULT 0);
            CREATE TABLE IF NOT EXISTS groups (group_id SERIAL PRIMARY KEY, family_id INTEGER, group_name VARCHAR(100), created_by INTEGER);
            CREATE TABLE IF NOT EXISTS group_members (group_id INTEGER, user_id INTEGER, PRIMARY KEY (group_id, user_id));
            CREATE TABLE IF NOT EXISTS messages (id SERIAL PRIMARY KEY, sender_id INTEGER, target_type VARCHAR(20) DEFAULT 'all', target_id INTEGER, file_path TEXT, msg_type VARCHAR(20) DEFAULT 'regular', is_deleted BOOLEAN DEFAULT false, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP);
            CREATE TABLE IF NOT EXISTS message_reads (user_id INTEGER, message_id INTEGER, is_hidden_locally BOOLEAN DEFAULT false, PRIMARY KEY (user_id, message_id));
        `);
        console.log("🚀 DATABASE STRUCT & GROUPS VERIFIED.");
    } catch (err) { console.error("❌ DATABASE INITIALIZATION FAILED:", err); }
});