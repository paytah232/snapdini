/** @type {import('drizzle-kit').Config} */
module.exports = {
  schema: './src/server/schema.ts',
  out: './src/server/drizzle',
  dialect: 'postgresql',
  dbCredentials: {
    url: process.env.DATABASE_URL || 'postgres://snapdini:snapdini@localhost:5432/snapdini',
  },
};
