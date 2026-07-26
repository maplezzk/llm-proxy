import { defineConfig } from 'drizzle-kit';

export default defineConfig({
  schema: './src/db/schema/index.ts',
  out: './drizzle',
  dialect: 'postgresql',
  dbCredentials: {
    url: process.env.DATABASE_URL ?? 'postgres://dev:dev@127.0.0.1:5432/llmproxy_dev',
  },
  verbose: true,
  strict: true,
});
