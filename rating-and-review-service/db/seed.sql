-- Seed data for ratings (assumes orders 1-3 exist and are delivered)
INSERT INTO ratings (order_id, restaurant_id, customer_id, score, review_text) VALUES
  (1, 1, 'customer-1', 5, 'Amazing pizza, delivered hot!'),
  (2, 1, 'customer-2', 4, 'Great pasta, slightly late delivery'),
  (3, 2, 'customer-1', 5, 'Best sushi in town');
