INSERT INTO orders (idempotency_key, customer_id, restaurant_id, items, total_price, status) VALUES
  ('seed-order-001', 'customer-1', '1', '[{"item_id": 1, "quantity": 2}, {"item_id": 3, "quantity": 1}]', 32.00, 'delivered'),
  ('seed-order-002', 'customer-2', '2', '[{"item_id": 4, "quantity": 3}]', 30.00, 'in_transit'),
  ('seed-order-003', 'customer-1', '3', '[{"item_id": 6, "quantity": 1}, {"item_id": 7, "quantity": 2}]', 24.98, 'pending');
