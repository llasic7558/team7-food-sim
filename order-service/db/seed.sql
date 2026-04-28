INSERT INTO orders (customer_id, restaurant_id, items, base_total_price, total_price, payment_status, payment_reference, status) VALUES
  ('customer-1', '1', '[{"item_id": 1, "quantity": 2}, {"item_id": 3, "quantity": 1}]', 32.00, 32.00, 'captured', 'seed-payment-1', 'delivered'),
  ('customer-2', '2', '[{"item_id": 4, "quantity": 3}]', 30.00, 30.00, 'authorized', 'seed-payment-2', 'in_transit'),
  ('customer-1', '3', '[{"item_id": 6, "quantity": 1}, {"item_id": 7, "quantity": 2}]', 24.98, 24.98, 'authorized', 'seed-payment-3', 'pending');
