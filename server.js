const express = require("express");
const { Pool } = require("pg");

const app = express();

const PORT = process.env.PORT || 3000;


const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl:{
        rejectUnauthorized:false
    }
});


app.use(express.urlencoded({extended:true}));
app.use(express.json());


app.use((req,res,next)=>{
    res.setHeader(
        "Content-Type",
        "text/plain; charset=utf-8"
    );
    next();
});


app.get("/",(req,res)=>{
    res.send(
        "id_list_message=t-השרת פעיל בהצלחה"
    );
});



app.get("/api/v1/auth", async (req,res)=>{


    const phone =
        req.query.ApiPhone || "";


    const digits =
        req.query.digits || "";


    try{


        const result =
        await pool.query(
        `
        SELECT u.*,t.tenant_name
        FROM users u
        JOIN tenants t
        ON u.family_id=t.family_id
        WHERE u.phone_number=$1
        `,
        [phone]
        );



        if(result.rows.length > 0){


            const user=result.rows[0];


            if(user.is_approved){


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
                "read=t-ברוכים הבאים למערכת להאזנה להודעות הקישו 1 להקלטת הודעה הקישו 2=digits,yes,1,1,5,Number,no"
                );

            }

        }



        if(!digits){

            return res.send(
            "read=t-המספר אינו מוכר במערכת הקישו קוד הצטרפות=digits,yes,6,6,10,Number,no"
            );

        }



        const family =
        await pool.query(
        "SELECT * FROM tenants WHERE join_code=$1",
        [digits]
        );


        if(family.rows.length===0){

            return res.send(
            "id_list_message=t-הקוד שגוי"
            );

        }



        await pool.query(

        `
        INSERT INTO users
        (family_id,phone_number,user_name,is_approved)
        VALUES($1,$2,$3,false)
        ON CONFLICT DO NOTHING
        `,

        [
            family.rows[0].family_id,
            phone,
            "משתמש חדש"
        ]

        );



        res.send(
        "id_list_message=t-הבקשה נקלטה וממתינה לאישור"
        );


    }
    catch(err){

        console.log(err);

        res.send(
        "id_list_message=t-שגיאה בשרת"
        );

    }


});



app.listen(PORT,()=>{

console.log(
"SERVER RUNNING "+PORT
);

});const express = require("express");
const { Pool } = require("pg");

const app = express();

const PORT = process.env.PORT || 3000;


const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl:{
        rejectUnauthorized:false
    }
});


app.use(express.urlencoded({extended:true}));
app.use(express.json());


app.use((req,res,next)=>{
    res.setHeader(
        "Content-Type",
        "text/plain; charset=utf-8"
    );
    next();
});


app.get("/",(req,res)=>{
    res.send(
        "id_list_message=t-השרת פעיל בהצלחה"
    );
});



app.get("/api/v1/auth", async (req,res)=>{


    const phone =
        req.query.ApiPhone || "";


    const digits =
        req.query.digits || "";


    try{


        const result =
        await pool.query(
        `
        SELECT u.*,t.tenant_name
        FROM users u
        JOIN tenants t
        ON u.family_id=t.family_id
        WHERE u.phone_number=$1
        `,
        [phone]
        );



        if(result.rows.length > 0){


            const user=result.rows[0];


            if(user.is_approved){


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
                "read=t-ברוכים הבאים למערכת להאזנה להודעות הקישו 1 להקלטת הודעה הקישו 2=digits,yes,1,1,5,Number,no"
                );

            }

        }



        if(!digits){

            return res.send(
            "read=t-המספר אינו מוכר במערכת הקישו קוד הצטרפות=digits,yes,6,6,10,Number,no"
            );

        }



        const family =
        await pool.query(
        "SELECT * FROM tenants WHERE join_code=$1",
        [digits]
        );


        if(family.rows.length===0){

            return res.send(
            "id_list_message=t-הקוד שגוי"
            );

        }



        await pool.query(

        `
        INSERT INTO users
        (family_id,phone_number,user_name,is_approved)
        VALUES($1,$2,$3,false)
        ON CONFLICT DO NOTHING
        `,

        [
            family.rows[0].family_id,
            phone,
            "משתמש חדש"
        ]

        );



        res.send(
        "id_list_message=t-הבקשה נקלטה וממתינה לאישור"
        );


    }
    catch(err){

        console.log(err);

        res.send(
        "id_list_message=t-שגיאה בשרת"
        );

    }


});



app.listen(PORT,()=>{

console.log(
"SERVER RUNNING "+PORT
);

});