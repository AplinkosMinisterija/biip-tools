const { knexSnakeCaseMappers } = require('objection');
require('dotenv').config();

export const boundariesConfig = {
  client: 'pg',
  connection: process.env.BOUNDARIES_DB_CONNECTION,
  pool: { min: 0, max: 7 },
  ...knexSnakeCaseMappers(),
};
