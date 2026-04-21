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
  //updating so that we update order service information with thier
  //assigned driver 
  const { order_id } = req.body || {};
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

    //update the assignment on the order row so downstream services can read it.
    if (order_id !== undefined) {
      try {
        const resp = await fetch(`${ORDER_SERVICE_URL}/orders/${order_id}/status`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ status: "dispatched", driver_id: driver.id }),
        });
        if (!resp.ok) {
          console.error(`order-service returned ${resp.status} for order ${order_id}`);
        }
      } catch (err) {
        console.error(`failed to persist driver_id on order ${order_id}:`, err.message);
      }
    }

    res.json(updated.rows[0]);


  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "failed to assign driver" });
  }
});

//helper for delivery-tracker-service update a driver's distance_from_order
// code is signifying the end condtion of the app, where once a driver has driven thier
// order to the destination, we can free them and complete thier delievery as well
const ORDER_SERVICE_URL = process.env.ORDER_SERVICE_URL || "http://order-service:8000";
app.put("/drivers/:id/distance", async (req, res) => {
  //distance from order is always given, but stataus and order id only sent from
  // delveiry tracker service when the tracker is done with the simulation
  // and the order has been "delivered"
  const { distance_from_order, status, order_id } = req.body || {};
  if (distance_from_order === undefined) {
    return res.status(400).json({ error: "distance_from_order is required" });
  }
  if (status !== undefined && status !== "Free" && status !== "Busy") {
    return res.status(400).json({ error: "status, if present, must be 'Free' or 'Busy'" });
  }

  try {
    //we are setting the driver free as thier status is now "Free"
    let result;
    if(status !== undefined){
      result = await db.query(
          "UPDATE drivers SET distance_from_order = $1, status = $2 WHERE id = $3 RETURNING *",
          [distance_from_order, status, req.params.id]
        )
    }else{
      result = await db.query(
          "UPDATE drivers SET distance_from_order = $1 WHERE id = $2 RETURNING *",
          [distance_from_order, req.params.id]
        );
    }
    if (result.rows.length === 0) {
      return res.status(404).json({ error: "driver not found", id: req.params.id });
    }

    const driver = result.rows[0];
    //checking if order is complted and done
    let orderCompleted = false;
    //driver is free and the order exists, a double check for my own sanity
    if (status === "Free" && order_id !== undefined) {
      try {
        //could double check if order id has the right driver id, but logically
        //should not have to
        const resp = await fetch(`${ORDER_SERVICE_URL}/orders/${order_id}/status`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ status: "delivered" }),
        });
        if (!resp.ok) {
          console.error(`order-service returned ${resp.status} for order ${order_id}`);
        } else {
          orderCompleted = true;
        }
      } catch (err) {
        console.error(`failed to mark order ${order_id} delivered:`, err.message);
      }
    }
    //send back to delveiry tracker the info and if the order is done, for notification worker(later)
    res.json({ ...driver, order_completed: orderCompleted });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "failed to update driver" });
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

app.get("/drivers/:id", async (req, res) => {
  try {
    const result = await db.query("SELECT * FROM drivers WHERE id = $1", [req.params.id]);
    if (result.rows.length === 0) {
      return res.status(404).json({ error: "driver not found", id: req.params.id });
    }
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: "internal server error" });
  }
});
