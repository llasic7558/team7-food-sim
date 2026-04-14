from datetime import datetime, timezone
from db import db


class Order(db.Model):
    __tablename__ = "orders"

    id            = db.Column(db.Integer, primary_key=True)
    idempotency_key = db.Column(db.String(128), unique=True, nullable=False, index=True)
    customer_id   = db.Column(db.String(64), nullable=False)
    restaurant_id = db.Column(db.String(64), nullable=False)
    items         = db.Column(db.JSON, nullable=False)   # [{"item_id": ..., "quantity": ...}]
    total_price   = db.Column(db.Numeric(10, 2), nullable=False)
    status        = db.Column(db.String(32), nullable=False, default="pending")
    # pending | confirmed | dispatched | ready | in_transit | delivered | failed
    driver_id     = db.Column(db.String(64), nullable=True)
    created_at    = db.Column(db.DateTime, default=lambda: datetime.now(timezone.utc))
    updated_at    = db.Column(
        db.DateTime,
        default=lambda: datetime.now(timezone.utc),
    )

    def to_dict(self):
        return {
            "id":               self.id,
            "idempotency_key":  self.idempotency_key,
            "customer_id":      self.customer_id,
            "restaurant_id":    self.restaurant_id,
            "items":            self.items,
            "total_price":      float(self.total_price),  
            "status":           self.status,
            "driver_id":        self.driver_id,
            "created_at":       self.created_at.isoformat(),
            "updated_at":       self.updated_at.isoformat(),
        }