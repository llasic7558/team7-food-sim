INSERT INTO drivers (name, status, location)
SELECT seed.name, seed.status, seed.location
FROM (
  VALUES
    ('Joe', 'Free', 'Boston'),
    ('Bob', 'Free', 'Amherst'),
    ('Alex', 'Free', 'Amherst'),
    ('Mia', 'Free', 'Cambridge'),
    ('Noah', 'Free', 'Somerville'),
    ('Emma', 'Free', 'Brookline'),
    ('Liam', 'Free', 'Watertown'),
    ('Olivia', 'Free', 'Newton'),
    ('Ethan', 'Free', 'Medford'),
    ('Sophia', 'Free', 'Quincy')
) AS seed(name, status, location)
WHERE NOT EXISTS (SELECT 1 FROM drivers);
