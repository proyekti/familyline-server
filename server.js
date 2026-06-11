// ==========================================
// 2. MIDDLEWARES: ניהול Context ו-SaaS Tenant
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

/**
 * ה-Middleware שונה לפונקציה רגילה שנפעיל רק בנתיבים מוגנים
 */
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
            // משתמש לא רשום - נשאר בשלוחת ה-Auth
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

// החלת ה-Context הגלובלי בלבד
app.use(y_telephonyContext);

// ==========================================
// 3. ROUTING SYSTEM: ניתוב שלוחות ימות המשיח
// ==========================================

// שלוחת כניסה ואימות (פתוחה - ללא requireTenant)
app.get('/api/v1/auth', async (req, res) => {
    const db = req.app.get('db');
    const { phone } = req.telephony;
    const digits = req.query.digits;

    try {
        // בדיקה האם המשתמש כבר קיים ומאושר
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

// שלוחות מוגנות - שים לב לתוספת של requireTenant באמצע!
app.get('/api/v1/listen', requireTenant, async (req, res) => {
    return res.send(`id_list_message=t-נכנסתם לשלוחת ההאזנה של ${req.tenant.familyName}.`);
});

app.get('/api/v1/send', requireTenant, async (req, res) => {
    return res.send('id_list_message=t-שלוחת שליחת הודעות בבנייה.');
});

app.get('/api/v1/tzintuk', requireTenant, async (req, res) => {
    // ... לוגיקת צינתוקים קיימת
    return res.send('id_list_message=t-שלוחת צינתוקים.');
});