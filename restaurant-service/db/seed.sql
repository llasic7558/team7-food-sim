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

INSERT INTO availability_windows (restaurant_id, day_of_week, opens_at, closes_at) VALUES
  (1, 0, '11:00', '21:00'),
  (1, 1, '11:00', '21:00'),
  (1, 2, '11:00', '21:00'),
  (1, 3, '11:00', '21:00'),
  (1, 4, '11:00', '22:00'),
  (1, 5, '11:00', '22:00'),
  (1, 6, '11:00', '20:00'),
  (2, 0, '12:00', '20:00'),
  (2, 1, '12:00', '21:00'),
  (2, 2, '12:00', '21:00'),
  (2, 3, '12:00', '21:00'),
  (2, 4, '12:00', '22:00'),
  (2, 5, '12:00', '22:00'),
  (2, 6, '12:00', '20:00'),
  (3, 0, '10:00', '20:00'),
  (3, 1, '10:00', '21:00'),
  (3, 2, '10:00', '21:00'),
  (3, 3, '10:00', '21:00'),
  (3, 4, '10:00', '22:00'),
  (3, 5, '10:00', '22:00'),
  (3, 6, '10:00', '20:00');
