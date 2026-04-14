INSERT INTO restaurants (name, cuisine, address, rating) VALUES
  ('Bella Italia', 'Italian', '123 Main St', 4.5),
  ('Sakura Sushi', 'Japanese', '456 Elm St', 4.2),
  ('Taco Fiesta', 'Mexican', '789 Oak Ave', 4.0);

INSERT INTO menu_items (restaurant_id, name, description, price) VALUES
  (1, 'Margherita Pizza', 'Classic tomato and mozzarella', 12),
  (1, 'Pasta Carbonara', 'Creamy egg and pancetta', 14),
  (1, 'Tiramisu', 'Coffee-flavored dessert', 8),
  (2, 'Salmon Roll', 'Fresh salmon and rice', 10),
  (2, 'Miso Soup', 'Traditional soybean soup', 4),
  (3, 'Beef Burrito', 'Seasoned beef with rice and beans', 11),
  (3, 'Churros', 'Fried dough with cinnamon sugar', 6.99);
