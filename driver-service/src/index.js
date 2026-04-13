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
