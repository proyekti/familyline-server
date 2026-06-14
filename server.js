const express = require("express");
const { Pool } = require("pg");
require("dotenv").config();

const app = express();
const PORT = process.env.PORT || 3000;

// =========================
// חיבור למסד נתונים
// =========================
const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }
});

app.use(express.urlencoded({ extended: true }));
app.use(express.json());

// חובה לימות המשיח: טקסט נקי
app.use((req, res, next) => {
    res.setHeader("Content-Type", "text/plain; charset=utf-8");
    next();
});

// =========================
// כלי עזר בטוח לקריאת פרמטרים
// =========================
const getParam = (req, name) => {
    return (req.query && req.query[name]) || (req.body && req.body[name]) || null;
};

// =========================
// 1. AUTH - כניסה / הרשמה
// =========================
app.get("/api/v1/auth", async (req, res) => {
    const phone = getParam(req, "ApiPhone") || "0000000000";
    const digits = getParam(req, "ApiDigits");

    try {
        const userQuery = `
            SELECT u.id as user_id, u.family_id, u.is_approved, t.tenant_name 
            FROM users u
            JOIN tenants t ON u.family_id = t.family_id
            WHERE u.phone_number = $1 AND t.is_active = TRUE
        `;

        const result = await pool.query(userQuery, [phone]);

        // משתמש קיים ומאושר
        if (result.rows.length > 0 && result.rows[0].is_approved) {
            const user = result.rows[0];

            if (digits === "1") return res.send("go_to_folder=/1");
            if (digits === "2") return res.send("go_to_folder=/2");

            return res.send(
                `read=t-ברוכים הבאים למערכת של ${user.tenant_name}. להאזנה הקש 1, להקלטה הקש 2=ApiDigits,yes,1,1,7,Number,no`
            );
        }

        // משתמש לא מאושר
        if (result.rows.length > 0 && !result.rows[0].is_approved) {
            return res.send("id_list_message=t-ממתין לאישור מנהל&hangup=yes");
        }

        // משתמש חדש
        if (!digits) {
            return res.send(
                "read=t-מספר לא מוכר. הקש קוד משפחתי ולאחר מכן סולמית=ApiDigits,yes,6,6,10,Number,no"
            );
        }

        const tenantCheck = await pool.query(
            "SELECT family_id, tenant_name FROM tenants WHERE join_code = $1 AND is_active = true",
            [digits]
        );

        if (tenantCheck.rows.length === 0) {
            return res.send("id_list_message=t-קוד שגוי&hangup=yes");
        }

        const tenant = tenantCheck.rows[0];

        await pool.query(
            "INSERT INTO users (family_id, phone_number, user_name, role, is_approved) VALUES ($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING",
            [tenant.family_id, phone, "משתמש חדש", "user", false]
        );

        return res.send(
            `id_list_message=t-הבקשה נשלחה למשפחת ${tenant.tenant_name}&hangup=yes`
        );

    } catch (err) {
        console.error(err);
        return res.send("id_list_message=t-שגיאת מערכת&hangup=yes");
    }
});

// =========================
// 2. LISTEN - האזנה
// =========================
app.get("/api/v1/listen", async (req, res) => {
    const phone = getParam(req, "ApiPhone") || "0000000000";
    const digits = getParam(req, "ApiDigits");

    try {
        const userResult = await pool.query(
            "SELECT id, family_id FROM users WHERE phone_number=$1 AND is_approved=true",
            [phone]
        );

        if (userResult.rows.length === 0) {
            return res.send("id_list_message=t-אין גישה&hangup=yes");
        }

        const { family_id } = userResult.rows[0];

        const msgResult = await pool.query(
            "SELECT id, file_path FROM messages WHERE family_id=$1 ORDER BY id DESC LIMIT 1",
            [family_id]
        );

        if (msgResult.rows.length === 0) {
            return res.send("id_list_message=t-אין הודעות&go_to_folder=/");
        }

        const msg = msgResult.rows[0];

        if (digits === "7") {
            await pool.query("DELETE FROM messages WHERE id=$1", [msg.id]);
            return res.send("id_list_message=t-נמחק&go_to_folder=/");
        }

        return res.send(
            `id_list_message=f-${msg.file_path}&read=t-הקש 7 למחיקה או 1 להמשך=ApiDigits,yes,1,1,7,Number,no`
        );

    } catch (err) {
        console.error(err);
        return res.send("id_list_message=t-שגיאה&go_to_folder=/");
    }
});

// =========================
// 3. RECORD - הקלטה
// =========================
app.get("/api/v1/record", async (req, res) => {
    const phone = getParam(req, "ApiPhone") || "0000000000";
    const fileUrl = getParam(req, "FileUrl");

    try {
        const userResult = await pool.query(
            "SELECT id, family_id FROM users WHERE phone_number=$1",
            [phone]
        );

        if (userResult.rows.length === 0) {
            return res.send("id_list_message=t-אין גישה&hangup=yes");
        }

        const { id, family_id } = userResult.rows[0];

        // התחלת הקלטה
        if (!fileUrl) {
            return res.send("type=record&record_path=current");
        }

        // שמירה אחרי הקלטה
        await pool.query(
            "INSERT INTO messages (family_id, sender_id, file_path) VALUES ($1,$2,$3)",
            [family_id, id, fileUrl]
        );

        return res.send("id_list_message=t-ההקלטה נשמרה&go_to_folder=/");

    } catch (err) {
        console.error(err);
        return res.send("id_list_message=t-שגיאה בהקלטה&go_to_folder=/");
    }
});

// =========================
// הפעלת שרת
// =========================
app.listen(PORT, () => {
    console.log("Server running on port " + PORT);
});