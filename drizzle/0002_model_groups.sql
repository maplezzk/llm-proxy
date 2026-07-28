CREATE TABLE IF NOT EXISTS "model_group_channels" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"model_group_id" bigint NOT NULL,
	"provider_model_id" bigint NOT NULL,
	"priority" integer DEFAULT 0 NOT NULL,
	"context_window" integer,
	"max_output_tokens" integer,
	"enabled" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "model_group_channels_group_provider_model_unique" UNIQUE("model_group_id","provider_model_id"),
	CONSTRAINT "model_group_channels_context_window_check" CHECK ("model_group_channels"."context_window" > 0),
	CONSTRAINT "model_group_channels_max_output_tokens_check" CHECK ("model_group_channels"."max_output_tokens" > 0)
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "model_groups" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"context_window" integer,
	"max_output_tokens" integer,
	"enabled" boolean DEFAULT true NOT NULL,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "model_groups_name_unique" UNIQUE("name"),
	CONSTRAINT "model_groups_context_window_check" CHECK ("model_groups"."context_window" > 0),
	CONSTRAINT "model_groups_max_output_tokens_check" CHECK ("model_groups"."max_output_tokens" > 0)
);
--> statement-breakpoint
ALTER TABLE "adapter_model_mappings" ALTER COLUMN "provider_model_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "adapter_model_mappings" ADD COLUMN IF NOT EXISTS "model_group_id" bigint;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "model_group_channels" ADD CONSTRAINT "model_group_channels_model_group_id_model_groups_id_fk" FOREIGN KEY ("model_group_id") REFERENCES "public"."model_groups"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "model_group_channels" ADD CONSTRAINT "model_group_channels_provider_model_id_provider_models_id_fk" FOREIGN KEY ("provider_model_id") REFERENCES "public"."provider_models"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_model_group_channels_group_priority" ON "model_group_channels" USING btree ("model_group_id","priority") WHERE "model_group_channels"."enabled";--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "adapter_model_mappings" ADD CONSTRAINT "adapter_model_mappings_model_group_id_model_groups_id_fk" FOREIGN KEY ("model_group_id") REFERENCES "public"."model_groups"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "adapter_model_mappings" ADD CONSTRAINT "adapter_model_mappings_target_check" CHECK ("adapter_model_mappings"."provider_model_id" IS NOT NULL OR "adapter_model_mappings"."model_group_id" IS NOT NULL);
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;