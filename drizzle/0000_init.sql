CREATE TABLE "audit_logs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_id" uuid,
	"outlet_id" uuid,
	"actor_id" uuid,
	"actor_role" text NOT NULL,
	"impersonator_id" uuid,
	"category" text NOT NULL,
	"action" text NOT NULL,
	"entity_type" text,
	"entity_id" text,
	"before" jsonb,
	"after" jsonb,
	"reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "auth_sessions" (
	"token_hash" text PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"impersonator_id" uuid,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "cards" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_id" uuid NOT NULL,
	"uid" text NOT NULL,
	"member_id" uuid,
	"status" text DEFAULT 'unassigned' NOT NULL,
	"reason" text,
	"replaced_by_card_id" uuid,
	"issued_outlet_id" uuid,
	"issued_by" uuid,
	"issued_at" timestamp with time zone,
	"blocked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "cards_status_ck" CHECK ("cards"."status" in ('unassigned','active','lost','replaced','damaged')),
	CONSTRAINT "cards_active_member_ck" CHECK ("cards"."status" <> 'active' or "cards"."member_id" is not null)
);
--> statement-breakpoint
CREATE TABLE "chip_transactions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"session_id" uuid NOT NULL,
	"outlet_id" uuid NOT NULL,
	"member_id" uuid NOT NULL,
	"type" text NOT NULL,
	"amount" bigint NOT NULL,
	"wallet_ledger_id" uuid,
	"actor_id" uuid NOT NULL,
	"idempotency_key" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "chips_amount_ck" CHECK ("chip_transactions"."amount" > 0),
	CONSTRAINT "chips_type_ck" CHECK ("chip_transactions"."type" in ('issue','return'))
);
--> statement-breakpoint
CREATE TABLE "food_order_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"order_id" uuid NOT NULL,
	"prior_status" text,
	"new_status" text NOT NULL,
	"actor_id" uuid NOT NULL,
	"reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "food_order_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"order_id" uuid NOT NULL,
	"menu_item_id" uuid,
	"item_name" text NOT NULL,
	"quantity" integer NOT NULL,
	"unit_price" bigint NOT NULL,
	"line_total" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "food_orders" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"outlet_id" uuid NOT NULL,
	"order_no" text NOT NULL,
	"member_id" uuid NOT NULL,
	"session_id" uuid,
	"table_id" uuid,
	"order_type" text NOT NULL,
	"guest_count" integer DEFAULT 0 NOT NULL,
	"payer_type" text DEFAULT 'none' NOT NULL,
	"payer_member_id" uuid,
	"status" text DEFAULT 'pending' NOT NULL,
	"total" bigint DEFAULT 0 NOT NULL,
	"payment_status" text DEFAULT 'not_applicable' NOT NULL,
	"created_by" uuid NOT NULL,
	"idempotency_key" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "orders_type_ck" CHECK ("food_orders"."order_type" in ('player','guest')),
	CONSTRAINT "orders_status_ck" CHECK ("food_orders"."status" in ('pending','preparing','ready','served','cancelled')),
	CONSTRAINT "orders_player_free_ck" CHECK ("food_orders"."order_type" <> 'player' or "food_orders"."total" = 0)
);
--> statement-breakpoint
CREATE TABLE "login_attempts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"email" text NOT NULL,
	"ok" boolean NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "members" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_id" uuid NOT NULL,
	"member_number" text NOT NULL,
	"name" text NOT NULL,
	"mobile" text NOT NULL,
	"email" text,
	"tier" text DEFAULT 'Bronze' NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"home_outlet_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "members_status_ck" CHECK ("members"."status" in ('active','suspended','closed')),
	CONSTRAINT "members_tier_ck" CHECK ("members"."tier" in ('Bronze','Silver','Gold','Platinum'))
);
--> statement-breakpoint
CREATE TABLE "menu_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"outlet_id" uuid NOT NULL,
	"name" text NOT NULL,
	"category" text DEFAULT 'Snacks' NOT NULL,
	"guest_price" bigint DEFAULT 0 NOT NULL,
	"available" boolean DEFAULT true NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "outlet_settings" (
	"outlet_id" uuid PRIMARY KEY NOT NULL,
	"guest_mode" text DEFAULT 'free' NOT NULL,
	"guest_payer" text DEFAULT 'player' NOT NULL,
	"issue_fee" bigint DEFAULT 10000 NOT NULL,
	"replacement_fee" bigint DEFAULT 20000 NOT NULL,
	"approval_threshold" bigint DEFAULT 500000 NOT NULL,
	"cashout_enabled" boolean DEFAULT false NOT NULL,
	"tier_fees" jsonb DEFAULT '{"Bronze":50000,"Silver":100000,"Gold":250000,"Platinum":500000}'::jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "outlets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_id" uuid NOT NULL,
	"name" text NOT NULL,
	"code" text NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "outlets_status_ck" CHECK ("outlets"."status" in ('active','closed'))
);
--> statement-breakpoint
CREATE TABLE "owners" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"plan" text DEFAULT 'trial' NOT NULL,
	"outlet_limit" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "owners_status_ck" CHECK ("owners"."status" in ('active','suspended')),
	CONSTRAINT "owners_plan_ck" CHECK ("owners"."plan" in ('trial','standard','pro')),
	CONSTRAINT "owners_limit_ck" CHECK ("owners"."outlet_limit" >= 1)
);
--> statement-breakpoint
CREATE TABLE "payments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"outlet_id" uuid NOT NULL,
	"member_id" uuid NOT NULL,
	"receipt_no" text NOT NULL,
	"amount" bigint NOT NULL,
	"method" text NOT NULL,
	"purpose" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"gateway_ref" text,
	"cashier_id" uuid NOT NULL,
	"shift_id" uuid,
	"card_id" uuid,
	"idempotency_key" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"confirmed_at" timestamp with time zone,
	CONSTRAINT "payments_amount_ck" CHECK ("payments"."amount" > 0),
	CONSTRAINT "payments_method_ck" CHECK ("payments"."method" in ('cash','upi','card')),
	CONSTRAINT "payments_purpose_ck" CHECK ("payments"."purpose" in ('recharge','card_issue','card_replacement')),
	CONSTRAINT "payments_status_ck" CHECK ("payments"."status" in ('pending','confirmed','failed'))
);
--> statement-breakpoint
CREATE TABLE "poker_sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"outlet_id" uuid NOT NULL,
	"table_id" uuid NOT NULL,
	"operator_id" uuid NOT NULL,
	"status" text DEFAULT 'in_progress' NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"ended_at" timestamp with time zone,
	"exception_amount" bigint DEFAULT 0 NOT NULL,
	"exception_note" text,
	"exception_resolved_at" timestamp with time zone,
	"exception_resolution" text,
	CONSTRAINT "sessions_status_ck" CHECK ("poker_sessions"."status" in ('in_progress','completed','cancelled'))
);
--> statement-breakpoint
CREATE TABLE "poker_tables" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"outlet_id" uuid NOT NULL,
	"name" text NOT NULL,
	"max_seats" integer DEFAULT 8 NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	CONSTRAINT "tables_seats_ck" CHECK ("poker_tables"."max_seats" between 2 and 8)
);
--> statement-breakpoint
CREATE TABLE "round_corrections" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"round_id" uuid NOT NULL,
	"before" jsonb NOT NULL,
	"after" jsonb NOT NULL,
	"reason" text NOT NULL,
	"actor_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "rounds" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"session_id" uuid NOT NULL,
	"outlet_id" uuid NOT NULL,
	"round_number" integer NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"winner_member_id" uuid,
	"pot" bigint DEFAULT 0 NOT NULL,
	"notes" text,
	"participants" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"entered_by" uuid NOT NULL,
	"submitted_at" timestamp with time zone,
	CONSTRAINT "rounds_status_ck" CHECK ("rounds"."status" in ('draft','submitted'))
);
--> statement-breakpoint
CREATE TABLE "session_players" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"session_id" uuid NOT NULL,
	"member_id" uuid NOT NULL,
	"seat_number" integer NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"joined_at" timestamp with time zone DEFAULT now() NOT NULL,
	"left_at" timestamp with time zone,
	CONSTRAINT "seat_range_ck" CHECK ("session_players"."seat_number" between 1 and 8),
	CONSTRAINT "seat_status_ck" CHECK ("session_players"."status" in ('active','left'))
);
--> statement-breakpoint
CREATE TABLE "shifts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"outlet_id" uuid NOT NULL,
	"cashier_id" uuid NOT NULL,
	"opened_at" timestamp with time zone DEFAULT now() NOT NULL,
	"opening_cash" bigint NOT NULL,
	"closed_at" timestamp with time zone,
	"expected" jsonb,
	"counted" jsonb,
	"discrepancy" bigint,
	"note" text,
	"status" text DEFAULT 'open' NOT NULL,
	"reviewer_id" uuid,
	"review_note" text,
	CONSTRAINT "shifts_status_ck" CHECK ("shifts"."status" in ('open','review','approved'))
);
--> statement-breakpoint
CREATE TABLE "user_outlets" (
	"user_id" uuid NOT NULL,
	"outlet_id" uuid NOT NULL
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"email" text NOT NULL,
	"password_hash" text NOT NULL,
	"name" text NOT NULL,
	"role" text NOT NULL,
	"owner_id" uuid,
	"status" text DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "users_role_ck" CHECK ("users"."role" in ('superadmin','owner','cashier','dealer','waiter','kds')),
	CONSTRAINT "users_status_ck" CHECK ("users"."status" in ('active','disabled')),
	CONSTRAINT "users_tenant_ck" CHECK (("users"."role" = 'superadmin') = ("users"."owner_id" is null))
);
--> statement-breakpoint
CREATE TABLE "wallet_ledger" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"wallet_id" uuid NOT NULL,
	"outlet_id" uuid NOT NULL,
	"member_id" uuid NOT NULL,
	"type" text NOT NULL,
	"direction" text NOT NULL,
	"amount" bigint NOT NULL,
	"balance_after" bigint NOT NULL,
	"ref_type" text,
	"ref_id" text,
	"payment_id" uuid,
	"reversal_of_id" uuid,
	"reason" text,
	"actor_id" uuid,
	"idempotency_key" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ledger_amount_ck" CHECK ("wallet_ledger"."amount" > 0),
	CONSTRAINT "ledger_direction_ck" CHECK ("wallet_ledger"."direction" in ('cr','dr')),
	CONSTRAINT "ledger_type_ck" CHECK ("wallet_ledger"."type" in ('recharge','chip_buy_in','chip_return','guest_food','adjustment','reversal'))
);
--> statement-breakpoint
CREATE TABLE "wallets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"member_id" uuid NOT NULL,
	"outlet_id" uuid NOT NULL,
	"balance" bigint DEFAULT 0 NOT NULL,
	"version" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "wallets_balance_ck" CHECK ("wallets"."balance" >= 0)
);
--> statement-breakpoint
ALTER TABLE "auth_sessions" ADD CONSTRAINT "auth_sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "auth_sessions" ADD CONSTRAINT "auth_sessions_impersonator_id_users_id_fk" FOREIGN KEY ("impersonator_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cards" ADD CONSTRAINT "cards_owner_id_owners_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."owners"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cards" ADD CONSTRAINT "cards_member_id_members_id_fk" FOREIGN KEY ("member_id") REFERENCES "public"."members"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cards" ADD CONSTRAINT "cards_issued_outlet_id_outlets_id_fk" FOREIGN KEY ("issued_outlet_id") REFERENCES "public"."outlets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cards" ADD CONSTRAINT "cards_issued_by_users_id_fk" FOREIGN KEY ("issued_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chip_transactions" ADD CONSTRAINT "chip_transactions_session_id_poker_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."poker_sessions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chip_transactions" ADD CONSTRAINT "chip_transactions_outlet_id_outlets_id_fk" FOREIGN KEY ("outlet_id") REFERENCES "public"."outlets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chip_transactions" ADD CONSTRAINT "chip_transactions_member_id_members_id_fk" FOREIGN KEY ("member_id") REFERENCES "public"."members"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chip_transactions" ADD CONSTRAINT "chip_transactions_wallet_ledger_id_wallet_ledger_id_fk" FOREIGN KEY ("wallet_ledger_id") REFERENCES "public"."wallet_ledger"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chip_transactions" ADD CONSTRAINT "chip_transactions_actor_id_users_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "food_order_events" ADD CONSTRAINT "food_order_events_order_id_food_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."food_orders"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "food_order_events" ADD CONSTRAINT "food_order_events_actor_id_users_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "food_order_items" ADD CONSTRAINT "food_order_items_order_id_food_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."food_orders"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "food_order_items" ADD CONSTRAINT "food_order_items_menu_item_id_menu_items_id_fk" FOREIGN KEY ("menu_item_id") REFERENCES "public"."menu_items"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "food_orders" ADD CONSTRAINT "food_orders_outlet_id_outlets_id_fk" FOREIGN KEY ("outlet_id") REFERENCES "public"."outlets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "food_orders" ADD CONSTRAINT "food_orders_member_id_members_id_fk" FOREIGN KEY ("member_id") REFERENCES "public"."members"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "food_orders" ADD CONSTRAINT "food_orders_session_id_poker_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."poker_sessions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "food_orders" ADD CONSTRAINT "food_orders_table_id_poker_tables_id_fk" FOREIGN KEY ("table_id") REFERENCES "public"."poker_tables"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "food_orders" ADD CONSTRAINT "food_orders_payer_member_id_members_id_fk" FOREIGN KEY ("payer_member_id") REFERENCES "public"."members"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "food_orders" ADD CONSTRAINT "food_orders_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "members" ADD CONSTRAINT "members_owner_id_owners_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."owners"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "members" ADD CONSTRAINT "members_home_outlet_id_outlets_id_fk" FOREIGN KEY ("home_outlet_id") REFERENCES "public"."outlets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "menu_items" ADD CONSTRAINT "menu_items_outlet_id_outlets_id_fk" FOREIGN KEY ("outlet_id") REFERENCES "public"."outlets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "outlet_settings" ADD CONSTRAINT "outlet_settings_outlet_id_outlets_id_fk" FOREIGN KEY ("outlet_id") REFERENCES "public"."outlets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "outlets" ADD CONSTRAINT "outlets_owner_id_owners_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."owners"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_outlet_id_outlets_id_fk" FOREIGN KEY ("outlet_id") REFERENCES "public"."outlets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_member_id_members_id_fk" FOREIGN KEY ("member_id") REFERENCES "public"."members"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_cashier_id_users_id_fk" FOREIGN KEY ("cashier_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_shift_id_shifts_id_fk" FOREIGN KEY ("shift_id") REFERENCES "public"."shifts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_card_id_cards_id_fk" FOREIGN KEY ("card_id") REFERENCES "public"."cards"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "poker_sessions" ADD CONSTRAINT "poker_sessions_outlet_id_outlets_id_fk" FOREIGN KEY ("outlet_id") REFERENCES "public"."outlets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "poker_sessions" ADD CONSTRAINT "poker_sessions_table_id_poker_tables_id_fk" FOREIGN KEY ("table_id") REFERENCES "public"."poker_tables"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "poker_sessions" ADD CONSTRAINT "poker_sessions_operator_id_users_id_fk" FOREIGN KEY ("operator_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "poker_tables" ADD CONSTRAINT "poker_tables_outlet_id_outlets_id_fk" FOREIGN KEY ("outlet_id") REFERENCES "public"."outlets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "round_corrections" ADD CONSTRAINT "round_corrections_round_id_rounds_id_fk" FOREIGN KEY ("round_id") REFERENCES "public"."rounds"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "round_corrections" ADD CONSTRAINT "round_corrections_actor_id_users_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rounds" ADD CONSTRAINT "rounds_session_id_poker_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."poker_sessions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rounds" ADD CONSTRAINT "rounds_outlet_id_outlets_id_fk" FOREIGN KEY ("outlet_id") REFERENCES "public"."outlets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rounds" ADD CONSTRAINT "rounds_winner_member_id_members_id_fk" FOREIGN KEY ("winner_member_id") REFERENCES "public"."members"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rounds" ADD CONSTRAINT "rounds_entered_by_users_id_fk" FOREIGN KEY ("entered_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "session_players" ADD CONSTRAINT "session_players_session_id_poker_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."poker_sessions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "session_players" ADD CONSTRAINT "session_players_member_id_members_id_fk" FOREIGN KEY ("member_id") REFERENCES "public"."members"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shifts" ADD CONSTRAINT "shifts_outlet_id_outlets_id_fk" FOREIGN KEY ("outlet_id") REFERENCES "public"."outlets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shifts" ADD CONSTRAINT "shifts_cashier_id_users_id_fk" FOREIGN KEY ("cashier_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shifts" ADD CONSTRAINT "shifts_reviewer_id_users_id_fk" FOREIGN KEY ("reviewer_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_outlets" ADD CONSTRAINT "user_outlets_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_outlets" ADD CONSTRAINT "user_outlets_outlet_id_outlets_id_fk" FOREIGN KEY ("outlet_id") REFERENCES "public"."outlets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_owner_id_owners_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."owners"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wallet_ledger" ADD CONSTRAINT "wallet_ledger_wallet_id_wallets_id_fk" FOREIGN KEY ("wallet_id") REFERENCES "public"."wallets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wallet_ledger" ADD CONSTRAINT "wallet_ledger_outlet_id_outlets_id_fk" FOREIGN KEY ("outlet_id") REFERENCES "public"."outlets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wallet_ledger" ADD CONSTRAINT "wallet_ledger_member_id_members_id_fk" FOREIGN KEY ("member_id") REFERENCES "public"."members"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wallet_ledger" ADD CONSTRAINT "wallet_ledger_payment_id_payments_id_fk" FOREIGN KEY ("payment_id") REFERENCES "public"."payments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wallet_ledger" ADD CONSTRAINT "wallet_ledger_actor_id_users_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wallets" ADD CONSTRAINT "wallets_member_id_members_id_fk" FOREIGN KEY ("member_id") REFERENCES "public"."members"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wallets" ADD CONSTRAINT "wallets_outlet_id_outlets_id_fk" FOREIGN KEY ("outlet_id") REFERENCES "public"."outlets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "audit_owner_idx" ON "audit_logs" USING btree ("owner_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "cards_uid_uq" ON "cards" USING btree ("uid");--> statement-breakpoint
CREATE UNIQUE INDEX "cards_one_active_per_member_uq" ON "cards" USING btree ("member_id") WHERE "cards"."status" = 'active';--> statement-breakpoint
CREATE UNIQUE INDEX "chips_idem_uq" ON "chip_transactions" USING btree ("outlet_id","idempotency_key");--> statement-breakpoint
CREATE UNIQUE INDEX "orders_no_uq" ON "food_orders" USING btree ("outlet_id","order_no");--> statement-breakpoint
CREATE UNIQUE INDEX "orders_idem_uq" ON "food_orders" USING btree ("outlet_id","idempotency_key");--> statement-breakpoint
CREATE INDEX "orders_board_idx" ON "food_orders" USING btree ("outlet_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "members_owner_number_uq" ON "members" USING btree ("owner_id","member_number");--> statement-breakpoint
CREATE UNIQUE INDEX "members_owner_mobile_uq" ON "members" USING btree ("owner_id","mobile");--> statement-breakpoint
CREATE UNIQUE INDEX "outlets_owner_code_uq" ON "outlets" USING btree ("owner_id","code");--> statement-breakpoint
CREATE UNIQUE INDEX "payments_receipt_uq" ON "payments" USING btree ("receipt_no");--> statement-breakpoint
CREATE UNIQUE INDEX "payments_idem_uq" ON "payments" USING btree ("outlet_id","idempotency_key");--> statement-breakpoint
CREATE UNIQUE INDEX "payments_one_per_card_uq" ON "payments" USING btree ("card_id") WHERE "payments"."card_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "sessions_one_open_per_table_uq" ON "poker_sessions" USING btree ("table_id") WHERE "poker_sessions"."status" = 'in_progress';--> statement-breakpoint
CREATE UNIQUE INDEX "tables_outlet_name_uq" ON "poker_tables" USING btree ("outlet_id","name");--> statement-breakpoint
CREATE UNIQUE INDEX "rounds_number_uq" ON "rounds" USING btree ("session_id","round_number");--> statement-breakpoint
CREATE UNIQUE INDEX "seat_unique_active_uq" ON "session_players" USING btree ("session_id","seat_number") WHERE "session_players"."status" = 'active';--> statement-breakpoint
CREATE UNIQUE INDEX "member_one_active_seat_uq" ON "session_players" USING btree ("member_id") WHERE "session_players"."status" = 'active';--> statement-breakpoint
CREATE UNIQUE INDEX "shifts_one_open_per_cashier_uq" ON "shifts" USING btree ("outlet_id","cashier_id") WHERE "shifts"."status" = 'open';--> statement-breakpoint
CREATE UNIQUE INDEX "user_outlets_uq" ON "user_outlets" USING btree ("user_id","outlet_id");--> statement-breakpoint
CREATE UNIQUE INDEX "users_email_uq" ON "users" USING btree ("email");--> statement-breakpoint
CREATE UNIQUE INDEX "ledger_idem_uq" ON "wallet_ledger" USING btree ("outlet_id","idempotency_key");--> statement-breakpoint
CREATE UNIQUE INDEX "ledger_one_reversal_uq" ON "wallet_ledger" USING btree ("reversal_of_id") WHERE "wallet_ledger"."reversal_of_id" is not null;--> statement-breakpoint
CREATE INDEX "ledger_member_idx" ON "wallet_ledger" USING btree ("member_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "wallets_member_outlet_uq" ON "wallets" USING btree ("member_id","outlet_id");