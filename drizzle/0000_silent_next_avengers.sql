CREATE TABLE IF NOT EXISTS "requests" (
	"id" serial PRIMARY KEY NOT NULL,
	"model" text NOT NULL,
	"provider" text NOT NULL,
	"status" integer NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
