const express = require("express");
const db = require("./db");

const app = express();
const PORT = process.env.PORT || 8000;
const ORDER_SERVICE_URL = process.env.ORDER_SERVICE_URL || "http://order-service:8000";

app.use(express.json());

app.get("/health", async (_req, res) => {
  try {
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

app.post("/assign", async (req, res) => {
  const { order_id } = req.body || {};
  console.log(`[driver-service] assignment requested order_id=${order_id}`);

  try {
    const result = await db.query(
      "SELECT * FROM drivers WHERE status = 'Free' LIMIT 1"
    );

    if (result.rows.length === 0) {
      console.log(`[driver-service] no drivers available order_id=${order_id}`);
      return res.status(404).json({ error: "no drivers available" });
    }

    const driver = result.rows[0];

    const updated = await db.query(
      "UPDATE drivers SET status = 'Busy' WHERE id = $1 RETURNING *",
      [driver.id]
    );

    if (order_id !== undefined) {
      try {
        const resp = await fetch(`${ORDER_SERVICE_URL}/orders/${order_id}/status`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ status: "dispatched", driver_id: driver.id }),
        });
        if (!resp.ok) {
          console.error(`[driver-service] order-service dispatch update failed order_id=${order_id} status=${resp.status}`);
        } else {
          console.log(`[driver-service] order-service dispatch update succeeded order_id=${order_id} driver_id=${driver.id}`);
        }
      } catch (err) {
        console.error(`[driver-service] failed to persist driver assignment order_id=${order_id}:`, err.message);
      }
    }

    console.log(`[driver-service] driver assigned order_id=${order_id} driver_id=${driver.id}`);
    res.json(updated.rows[0]);
  } catch (err) {
    console.error('[driver-service] failed to assign driver:', err.message);
    res.status(500).json({ error: "failed to assign driver" });
  }
});

app.put("/drivers/:id/distance", async (req, res) => {
  const { distance_from_order, status, order_id } = req.body || {};
  if (distance_from_order === undefined) {
    return res.status(400).json({ error: "distance_from_order is required" });
  }
  if (status !== undefined && status !== "Free" && status !== "Busy") {
    return res.status(400).json({ error: "status, if present, must be 'Free' or 'Busy'" });
  }

  try {
    let result;
    if (status !== undefined) {
      result = await db.query(
        "UPDATE drivers SET distance_from_order = $1, status = $2 WHERE id = $3 RETURNING *",
        [distance_from_order, status, req.params.id]
      );
    } else {
      result = await db.query(
        "UPDATE drivers SET distance_from_order = $1 WHERE id = $2 RETURNING *",
        [distance_from_order, req.params.id]
      );
    }
    if (result.rows.length === 0) {
      return res.status(404).json({ error: "driver not found", id: req.params.id });
    }

    const driver = result.rows[0];
    let orderCompleted = false;
    if (status === "Free" && order_id !== undefined) {
      try {
        const resp = await fetch(`${ORDER_SERVICE_URL}/orders/${order_id}/status`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ status: "delivered" }),
        });
        if (!resp.ok) {
          console.error(`[driver-service] order-service delivered update failed order_id=${order_id} status=${resp.status}`);
        } else {
          orderCompleted = true;
          console.log(`[driver-service] order marked delivered order_id=${order_id} driver_id=${req.params.id}`);
        }
      } catch (err) {
        console.error(`[driver-service] failed to mark delivered order_id=${order_id}:`, err.message);
      }
    }

    console.log(
      `[driver-service] driver distance updated driver_id=${req.params.id} distance=${distance_from_order} status=${status ?? driver.status} order_id=${order_id ?? 'none'}`
    );
    res.json({ ...driver, order_completed: orderCompleted });
  } catch (err) {
    console.error('[driver-service] failed to update driver:', err.message);
    res.status(500).json({ error: "failed to update driver" });
  }
});

app.listen(PORT, () => {
  console.log(`Driver service running on port ${PORT}`);
});

app.get("/drivers", async (req, res) => {
  try {
    const { status } = req.query;
    let result;
    if (status) {
      result = await db.query(
        "SELECT * FROM drivers WHERE status = $1",
        [status]
      );
    } else {
      result = await db.query("SELECT * FROM drivers");
    }
    console.log(`[driver-service] listed drivers count=${result.rows.length} status=${status ?? 'all'}`);
    res.json({ drivers: result.rows });
  } catch (err) {
    console.error('[driver-service] list drivers failed:', err.message);
    res.status(500).json({ error:"internal server error"});
  }
});

app.get("/drivers/:id", async (req, res) => {
  try {
    const result = await db.query("SELECT * FROM drivers WHERE id = $1", [req.params.id]);
    if (result.rows.length === 0) {
      return res.status(404).json({ error: "driver not found", id: req.params.id });
    }
    console.log(`[driver-service] fetched driver driver_id=${req.params.id}`);
    res.json(result.rows[0]);
  } catch (err) {
    console.error(`[driver-service] get driver failed driver_id=${req.params.id}:`, err.message);
    res.status(500).json({ error: "internal server error" });
  }
});
