const express=require("express");
const db=require("./db");
const app=express();
app.use(express.json());
const PORT=process.env.PORT || 8000;

app.get("/health",async(req, res)=>{//
  try{
    await db.query("SELECT 1");
    res.status(200).json({
      status: "healthy",
      service: "driver-service",
      checks: {
        database: { status: "healthy" }
      }
    });
  } catch (err) {
    res.status(503).json({
      status:"unhealthy",
      service:"driver-service",
      checks:{
        database:{status:"unhealthy"}
      }
    });
  }
});
/* 
curl -X POST http://localhost:8003/assign \
  -H "Content-Type: application/json" \
  -d '{"order_id":"test"}'
  returned {"id":3,"name":"Alex","status":"Busy","location":"Amherst"}%  
*/

app.post("/assign",async(req,res)=>{//8003/assign
  try {
    const result=await db.query(
      "SELECT * FROM drivers WHERE status = 'Free' LIMIT 1"
    );

    if (result.rows.length===0){
      return res.status(404).json({ error: "no drivers available" });
    }

    const driver = result.rows[0];

    //mark driver as busy
    const updated = await db.query(
      "UPDATE drivers SET status = 'Busy' WHERE id = $1 RETURNING *",
      [driver.id]
    );

    res.json(updated.rows[0]);


  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "failed to assign driver" });
  }
});

app.listen(PORT, () => {
  console.log(`Driver service running on port ${PORT}`);
});
app.get("/drivers", async(req,res)=>{
  try {
    const {status}=req.query;
    let result;
    if (status){
      result = await db.query(
        "SELECT * FROM drivers WHERE status = $1",
        [status]
      );
    } else {
      result=await db.query("SELECT * FROM drivers");
    }
    res.json({drivers:result.rows});
  } catch (err) {
    res.status(500).json({ error:"internal server error"});
  }
});
