const express = require('express');
const pool = require('./db');

const app = express();
const PORT = process.env.PORT || 8000;

app.use(express.json());

app.get('/health', (_req, res) => {
  res.json({ status: 'ok' });
});

app.listen(PORT, () => {
  console.log(`restaurant-service listening on port ${PORT}`);
});
