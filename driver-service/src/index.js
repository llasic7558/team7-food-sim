const express=require("express");
const db=require("./db");
const app=express();
app.use(express.json());
const PORT=process.env.PORT || 8000;

app.get("/health",async(req, res)=>{//
  try{
    await db.query("SELECT 1");
    res.status(200).json({status:"ok",db:"connected"});
  } catch (err) {
    res.status(500).json({status:"error",db:"down"});
  }
});

app.listen(PORT, () => {
  console.log(`Driver service running on port ${PORT}`);
});
