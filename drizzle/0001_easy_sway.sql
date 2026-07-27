CREATE TYPE "public"."protocol_type" AS ENUM('anthropic', 'openai', 'openai-responses');--> statement-breakpoint
CREATE TYPE "public"."reasoning_effort" AS ENUM('low', 'medium', 'high', 'xhigh', 'max');--> statement-breakpoint
CREATE TYPE "public"."stream_policy" AS ENUM('default_true', 'passthrough', 'force_true', 'force_false');--> statement-breakpoint
CREATE TYPE "public"."thinking_type" AS ENUM('enabled', 'disabled', 'adaptive', 'auto');--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "adapter_model_mappings" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"adapter_id" bigint NOT NULL,
	"source_model_id" text NOT NULL,
	"provider_model_id" bigint NOT NULL,
	"thinking_override" jsonb,
	"generation_overrides" jsonb,
	"enabled" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "adapter_model_mappings_adapter_id_source_model_id_unique" UNIQUE("adapter_id","source_model_id")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "adapters" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"inbound_type" "protocol_type" NOT NULL,
	"max_tokens_override" integer,
	"stream_policy" "stream_policy" DEFAULT 'passthrough' NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "adapters_name_unique" UNIQUE("name"),
	CONSTRAINT "adapters_max_tokens_override_check" CHECK ("adapters"."max_tokens_override" > 0)
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "provider_models" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"provider_id" bigint NOT NULL,
	"model_id" text NOT NULL,
	"display_name" text,
	"input_modalities" text[] DEFAULT '{"text"}' NOT NULL,
	"thinking_enabled" boolean DEFAULT false NOT NULL,
	"thinking_budget_tokens" integer,
	"thinking_reasoning_effort" "reasoning_effort",
	"thinking_type" "thinking_type",
	"max_output_tokens" integer,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "provider_models_provider_id_model_id_unique" UNIQUE("provider_id","model_id"),
	CONSTRAINT "provider_models_thinking_budget_tokens_check" CHECK ("provider_models"."thinking_budget_tokens" > 0),
	CONSTRAINT "provider_models_max_output_tokens_check" CHECK ("provider_models"."max_output_tokens" > 0)
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "providers" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"type" "protocol_type" NOT NULL,
	"api_base" text,
	"credential_ref" text NOT NULL,
	"priority" integer DEFAULT 0 NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "providers_name_unique" UNIQUE("name")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "proxy_settings" (
	"id" integer PRIMARY KEY DEFAULT 1 NOT NULL,
	"proxy_key_hash" text,
	"log_level" text DEFAULT 'info' NOT NULL,
	"locale" text DEFAULT 'en' NOT NULL,
	"port" integer DEFAULT 9000 NOT NULL,
	"capture_max_size" integer DEFAULT 1000 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "proxy_settings_id_check" CHECK ("proxy_settings"."id" = 1),
	CONSTRAINT "proxy_settings_log_level_check" CHECK ("proxy_settings"."log_level" IN ('debug', 'info', 'warn', 'error')),
	CONSTRAINT "proxy_settings_locale_check" CHECK ("proxy_settings"."locale" IN ('zh', 'en'))
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "usage_records" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"request_id" text NOT NULL,
	"trace_id" text,
	"client_protocol" "protocol_type" NOT NULL,
	"provider_id" bigint,
	"provider_model_id" bigint,
	"adapter_id" bigint,
	"logical_model" text NOT NULL,
	"resolved_model" text NOT NULL,
	"input_tokens" integer NOT NULL,
	"output_tokens" integer NOT NULL,
	"cache_read_tokens" integer DEFAULT 0 NOT NULL,
	"cache_creation_tokens" integer DEFAULT 0 NOT NULL,
	"reasoning_tokens" integer,
	"total_input_tokens" integer,
	"latency_ms" integer,
	"first_token_ms" integer,
	"status" text NOT NULL,
	"error_class" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "usage_records_status_check" CHECK ("usage_records"."status" IN ('success', 'error', 'timeout'))
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "vision_settings" (
	"id" integer PRIMARY KEY DEFAULT 1 NOT NULL,
	"provider_model_id" bigint NOT NULL,
	"prompt" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "vision_settings_id_check" CHECK ("vision_settings"."id" = 1)
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "adapter_model_mappings" ADD CONSTRAINT "adapter_model_mappings_adapter_id_adapters_id_fk" FOREIGN KEY ("adapter_id") REFERENCES "public"."adapters"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "adapter_model_mappings" ADD CONSTRAINT "adapter_model_mappings_provider_model_id_provider_models_id_fk" FOREIGN KEY ("provider_model_id") REFERENCES "public"."provider_models"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "provider_models" ADD CONSTRAINT "provider_models_provider_id_providers_id_fk" FOREIGN KEY ("provider_id") REFERENCES "public"."providers"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "usage_records" ADD CONSTRAINT "usage_records_provider_id_providers_id_fk" FOREIGN KEY ("provider_id") REFERENCES "public"."providers"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "usage_records" ADD CONSTRAINT "usage_records_provider_model_id_provider_models_id_fk" FOREIGN KEY ("provider_model_id") REFERENCES "public"."provider_models"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "usage_records" ADD CONSTRAINT "usage_records_adapter_id_adapters_id_fk" FOREIGN KEY ("adapter_id") REFERENCES "public"."adapters"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "vision_settings" ADD CONSTRAINT "vision_settings_provider_model_id_provider_models_id_fk" FOREIGN KEY ("provider_model_id") REFERENCES "public"."provider_models"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_adapter_mappings_adapter_id" ON "adapter_model_mappings" USING btree ("adapter_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_provider_models_model_id" ON "provider_models" USING btree ("model_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_providers_priority" ON "providers" USING btree ("priority") WHERE "providers"."enabled";--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_usage_records_provider_model" ON "usage_records" USING btree ("provider_model_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_usage_records_request_id" ON "usage_records" USING btree ("request_id");