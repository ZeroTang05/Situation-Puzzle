CREATE TABLE "otp_send_reservations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"email" text NOT NULL,
	"ip" "inet" NOT NULL,
	"reserved_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "otp_send_email_time_idx" ON "otp_send_reservations" USING btree ("email","reserved_at");--> statement-breakpoint
CREATE INDEX "otp_send_ip_time_idx" ON "otp_send_reservations" USING btree ("ip","reserved_at");--> statement-breakpoint
CREATE INDEX "otp_send_time_idx" ON "otp_send_reservations" USING btree ("reserved_at");--> statement-breakpoint
