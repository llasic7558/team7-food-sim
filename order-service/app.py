import json
import logging
import os
from datetime import datetime, timezone

import redis
import requests
from flask import Flask, jsonify, request
from sqlalchemy.exc import IntegrityError

from db import db
from models import Order

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

app = Flask(__name__)

db_url = os.environ.get(
    "DATABASE_URL",
    "postgresql://app:secret@order-db:5432/orders"
)
if db_url.startswith("postgres://"):
    db_url = db_url.replace("postgres://", "postgresql://", 1)

app.config["SQLALCHEMY_DATABASE_URI"] = db_url
app.config["SQLALCHEMY_TRACK_MODIFICATIONS"] = False

db.init_app(app)

REDIS_URL = os.environ.get("REDIS_URL", "redis://redis:6379/0")
redis_client = redis.from_url(REDIS_URL, decode_responses=True)

ORDER_DISPATCH_QUEUE = "queue:order_dispatch"
NOTIFICATION_QUEUE   = "queue:notifications"

RESTAURANT_SERVICE_URL = os.environ.get(
    "RESTAURANT_SERVICE_URL", "http://restaurant-service:8000"
)


def _menu_row_key(row: dict) -> str | None:
    """Restaurant menu may use `id` or `item_id`; normalize to string for lookup."""
    raw = row.get("item_id", row.get("id"))
    if raw is None:
        return None
    return str(raw)


def _line_item_key(line: dict) -> str | None:
    """Order line may use `item_id`, `menu_item_id`, or `id`."""
    raw = line.get("item_id") or line.get("menu_item_id") or line.get("id")
    if raw is None:
        return None
    return str(raw)


def validate_items_with_restaurant(restaurant_id: str, items: list) -> tuple[bool, str, float]:
    """
    Calls the Restaurant Service synchronously to validate menu items and
    get current prices (including any surge multiplier).
    Returns (ok, error_message, total_price).
    """
    try:
        resp = requests.get(
            f"{RESTAURANT_SERVICE_URL}/restaurants/{restaurant_id}/menu",
            timeout=5,
        )
    except requests.RequestException as exc:
        logger.error("Restaurant Service unreachable: %s", exc)
        return False, "Restaurant service unavailable", 0.0

    if resp.status_code == 404:
        return False, f"Restaurant '{restaurant_id}' not found", 0.0
    if not resp.ok:
        return False, "Failed to retrieve menu", 0.0

    body = resp.json()
    menu: dict[str, dict] = {}
    for item in body.get("items", []):
        key = _menu_row_key(item)
        if key:
            menu[key] = item

    total = 0.0
    for line in items:
        item_key = _line_item_key(line)
        if item_key is None:
            return False, "Each line item must include item_id (or menu_item_id / id)", 0.0
        qty = line.get("quantity", 1)
        if item_key not in menu:
            return False, f"Item '{item_key}' not on menu", 0.0
        try:
            price = float(menu[item_key]["price"])
        except (TypeError, ValueError, KeyError):
            return False, "Invalid menu item price from restaurant service", 0.0
        total += price * qty

    surge_multiplier = body.get("surge_multiplier", 1.0)
    total *= surge_multiplier

    return True, "", round(total, 2)


def push_notification(event: str, order: Order):
    payload = {"event": event, "order_id": order.id, "status": order.status}
    redis_client.lpush(NOTIFICATION_QUEUE, json.dumps(payload))



@app.route("/health")
def health():
    checks = {}
    healthy = True

    # Database health check
    try:
        db.session.execute(db.text("SELECT 1"))
        checks["database"] = {"status": "healthy"}
    except Exception as exc:
        checks["database"] = {"status": "unhealthy", "error": str(exc)}
        healthy = False

    # Redis health check
    try:
        redis_client.ping()
        checks["redis"] = {"status": "healthy"}
    except Exception as exc:
        checks["redis"] = {"status": "unhealthy", "error": str(exc)}
        healthy = False

    return jsonify(
        {
            "status": "healthy" if healthy else "unhealthy",
            "service": os.environ.get("SERVICE_NAME", "order-service"),
            "checks": checks,
        }
    ), (200 if healthy else 503)


@app.route("/orders", methods=["GET"])
def list_orders():
    """List all orders. Supports optional ?customer_id= and ?status= filters."""
    query = Order.query
    if cid := request.args.get("customer_id"):
        query = query.filter_by(customer_id=cid)
    if status := request.args.get("status"):
        query = query.filter_by(status=status)
    orders = query.order_by(Order.created_at.desc()).all()
    return jsonify([o.to_dict() for o in orders]), 200


@app.route("/orders", methods=["POST"])
def create_order():
    """
    Create a new order.
    Idempotency: if X-Idempotency-Key was already used, return the original
    order (HTTP 200) instead of creating a duplicate.
    """
    idempotency_key = request.headers.get("X-Idempotency-Key")
    if not idempotency_key:
        return jsonify({"error": "X-Idempotency-Key header is required"}), 400

    existing = Order.query.filter_by(idempotency_key=idempotency_key).first()
    if existing:
        logger.info("Duplicate order request for key %s — returning original", idempotency_key)
        return jsonify(existing.to_dict()), 200

    data = request.get_json(silent=True)
    if not data:
        return jsonify({"error": "JSON body required"}), 400

    required = ("customer_id", "restaurant_id", "items")
    missing  = [f for f in required if not data.get(f)]
    if missing:
        return jsonify({"error": f"Missing fields: {', '.join(missing)}"}), 400

    items = data["items"]
    if not isinstance(items, list) or not items:
        return jsonify({"error": "'items' must be a non-empty list"}), 400

    ok, err, total_price = validate_items_with_restaurant(data["restaurant_id"], items)
    if not ok:
        return jsonify({"error": err}), 422

    order = Order(
        idempotency_key=idempotency_key,
        customer_id=data["customer_id"],
        restaurant_id=data["restaurant_id"],
        items=items,
        total_price=total_price,
        status="pending",
    )
    db.session.add(order)
    try:
        db.session.commit()
    except IntegrityError:
        db.session.rollback()
        existing = Order.query.filter_by(idempotency_key=idempotency_key).first()
        return jsonify(existing.to_dict()), 200

    logger.info("Order %s created (customer=%s, restaurant=%s, total=$%.2f)",
                order.id, order.customer_id, order.restaurant_id, float(order.total_price))

    redis_client.rpush(
        ORDER_DISPATCH_QUEUE,
        json.dumps({"order_id": order.id, "restaurant_id": order.restaurant_id}),
    )

    push_notification("order_confirmed", order)

    return jsonify(order.to_dict()), 201


@app.route("/orders/<int:order_id>", methods=["GET"])
def get_order(order_id):
    order = Order.query.get_or_404(order_id)
    return jsonify(order.to_dict()), 200


@app.route("/orders/<int:order_id>/status", methods=["PUT"])
def update_status(order_id):
    """
    Internal endpoint called by workers to advance the order status.
    """
    order = Order.query.get_or_404(order_id)
    data  = request.get_json(silent=True) or {}
    new_status = data.get("status")

    valid_statuses = {"confirmed", "dispatched", "ready", "in_transit", "delivered", "failed"}
    if new_status not in valid_statuses:
        return jsonify({"error": f"Invalid status. Must be one of: {valid_statuses}"}), 400

    order.status     = new_status
    order.updated_at = datetime.now(timezone.utc)   # ← FIX: set manually (onupdate lambda unreliable)
    if "driver_id" in data:
        order.driver_id = data["driver_id"]

    db.session.commit()
    logger.info("Order %s → %s", order_id, new_status)

    push_notification(f"order_{new_status}", order)
    return jsonify(order.to_dict()), 200


@app.route("/orders/<int:order_id>/verify-completed", methods=["GET"])
def verify_completed(order_id):
    """
    Called by the Rating & Review Service to confirm an order was delivered
    before accepting a rating.
    """
    order     = Order.query.get_or_404(order_id)
    completed = order.status == "delivered"
    return jsonify({"order_id": order_id, "completed": completed}), 200


with app.app_context():
    db.create_all()