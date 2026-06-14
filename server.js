const express = require("express");
const { Pool } = require("pg");
require("dotenv").config();

const app = express();

const PORT = process.env.PORT || 3000;


const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: {
        rejectUnauthorized:false
    }
});


app.use(express.urlencoded({
    extended:true
}));

app.use(express.json());


app.use((req,res,next)=>{
    res.setHeader(
        "Content-Type",
        "text/plain; charset=utf-8"
    );
    next();
});



// בדיקת שרת
app.get("/",(req,res)=>{
    res.send("FamilyLine Server OK");
});



// כניסה ראשית
app.get("/api/v1/auth",async(req,res)=>{


const phone =
req.query.ApiPhone ||
req.body.ApiPhone;


const digits =
req.query.digits ||
req.body.digits;



try{


const user = await pool.query(
`
SELECT 
u.id,
u.family_id,
u.is_approved,
t.tenant_name

FROM users u

JOIN tenants t
ON u.family_id=t.family_id

WHERE u.phone_number=$1

`,
[phone]
);



if(user.rows.length>0){


if(user.rows[0].is_approved){



if(digits==="1"){

return res.send(
"go_to_folder=/1"
);

}


if(digits==="2"){

return res.send(
"go_to_folder=/2"
);

}



return res.send(

"read=t-ברוכים הבאים למערכת המשפחתית להאזנה להודעות הקישו 1 לשליחת הודעה חדשה הקישו 2=digits,yes,1,1,7,Number,no"

);


}



return res.send(
"id_list_message=t-המשתמש ממתין לאישור מנהל&hangup=yes"
);



}



// משתמש חדש


if(!digits){

return res.send(

"read=t-שלום. אנא הקישו קוד הצטרפות משפחתי=digits,yes,6,6,10,Number,no"

);


}



const family =
await pool.query(

`
SELECT family_id,tenant_name

FROM tenants

WHERE join_code=$1

AND is_active=true

`,
[digits]

);



if(family.rows.length===0){


return res.send(

"id_list_message=t-הקוד שגוי&hangup=yes"

);


}



await pool.query(

`

INSERT INTO users

(
family_id,
phone_number,
user_name,
role,
is_approved

)

VALUES

($1,$2,$3,$4,$5)

ON CONFLICT DO NOTHING

`,

[
family.rows[0].family_id,
phone,
"משתמש חדש",
"user",
false
]

);



return res.send(

"id_list_message=t-הבקשה התקבלה וממתינה לאישור מנהל&hangup=yes"

);



}

catch(err){

console.log(err);

return res.send(
"id_list_message=t-תקלה בשרת"
);

}


});





// שלוחת האזנה

app.get("/api/v1/listen",async(req,res)=>{


const phone =
req.query.ApiPhone;



try{


const result =
await pool.query(

`

SELECT id,family_id

FROM users

WHERE phone_number=$1

AND is_approved=true

`,
[phone]

);


if(result.rows.length===0){

return res.send(
"id_list_message=t-אין הרשאה"
);

}



const msg =
await pool.query(

`

SELECT *

FROM messages

WHERE family_id=$1

AND deleted_globally=false

ORDER BY id DESC

LIMIT 1

`,

[
result.rows[0].family_id
]

);



if(msg.rows.length===0){

return res.send(
"id_list_message=t-אין הודעות חדשות"
);

}



return res.send(

"id_list_message=f-"+msg.rows[0].file_name

);


}

catch(e){

console.log(e);

res.send(
"id_list_message=t-שגיאה"
);

}


});





app.listen(PORT,()=>{

console.log(
"FamilyLine running on "+PORT
);

});