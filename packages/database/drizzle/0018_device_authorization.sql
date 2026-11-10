CREATE TABLE "device_code" (
  "id" text PRIMARY KEY NOT NULL,
  "device_code" text NOT NULL,
  "user_code" text NOT NULL,
  "user_id" text REFERENCES "user"("id") ON DELETE CASCADE,
  "expires_at" timestamp with time zone NOT NULL,
  "status" text NOT NULL,
  "last_polled_at" timestamp with time zone,
  "polling_interval" integer,
  "client_id" text,
  "scope" text
);
--> statement-breakpoint
CREATE UNIQUE INDEX "device_code_device_uq" ON "device_code" ("device_code");
--> statement-breakpoint
CREATE UNIQUE INDEX "device_code_user_uq" ON "device_code" ("user_code");
