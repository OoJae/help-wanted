CREATE TABLE "api_health" (
	"hour" text PRIMARY KEY NOT NULL,
	"fetched_at_ms" bigint NOT NULL,
	"status" text,
	"connected_daemons" bigint,
	"working_now" bigint,
	"accepted_last_day" bigint,
	"pending_feedback" bigint,
	"payments_enabled" boolean,
	"paid_orders" bigint,
	"computed_at" text,
	"raw" jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "api_job_records" (
	"job_id" text NOT NULL,
	"record_id" text NOT NULL,
	"hash" text NOT NULL,
	"chain_id" bigint,
	"registry" text,
	"status" text,
	"tx_hash" text,
	"failure" jsonb,
	"fetched_at_ms" bigint NOT NULL,
	CONSTRAINT "api_job_records_job_id_record_id_pk" PRIMARY KEY("job_id","record_id")
);
--> statement-breakpoint
CREATE TABLE "api_jobs" (
	"id" text PRIMARY KEY NOT NULL,
	"state" text,
	"template" text,
	"objective" text,
	"paid_by" text,
	"launch_kind" text,
	"blocked_reason" text,
	"created_at" text,
	"updated_at" text,
	"watched" boolean DEFAULT false NOT NULL,
	"listed" jsonb,
	"detail" jsonb,
	"fetched_at_ms" bigint NOT NULL,
	"detail_fetched_at_ms" bigint
);
--> statement-breakpoint
CREATE TABLE "api_oracle_requests" (
	"id" text PRIMARY KEY NOT NULL,
	"status" text,
	"question" text,
	"chain_id" bigint,
	"answer_type" text,
	"job_id" text,
	"signer" text,
	"from_block" bigint,
	"to_block" bigint,
	"attested_at" text,
	"created_at" text,
	"updated_at" text,
	"raw" jsonb NOT NULL,
	"fetched_at_ms" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "chips" (
	"pot_id" bigint NOT NULL,
	"contributor" text NOT NULL,
	"amount" numeric(78, 0) NOT NULL,
	"chip_count" bigint NOT NULL,
	"refunded" numeric(78, 0),
	"first_block" bigint NOT NULL,
	"first_time" bigint NOT NULL,
	"last_block" bigint NOT NULL,
	"last_time" bigint NOT NULL,
	CONSTRAINT "chips_pot_id_contributor_pk" PRIMARY KEY("pot_id","contributor")
);
--> statement-breakpoint
CREATE TABLE "claims" (
	"order_id" bigint NOT NULL,
	"seq" bigint NOT NULL,
	"runner" text NOT NULL,
	"price" numeric(78, 0) NOT NULL,
	"bond" numeric(78, 0) NOT NULL,
	"ticket" text NOT NULL,
	"job_id" text,
	"record_hash" text,
	"challenge_until" bigint,
	"challenger" text,
	"challenger_bond" numeric(78, 0),
	"outcome" text,
	"to_runner" numeric(78, 0),
	"to_employer" numeric(78, 0),
	"to_challenger" numeric(78, 0),
	"claimed_block" bigint NOT NULL,
	"claimed_time" bigint NOT NULL,
	"claimed_tx" text NOT NULL,
	"ended_block" bigint,
	"ended_time" bigint,
	"ended_tx" text,
	CONSTRAINT "claims_order_id_seq_pk" PRIMARY KEY("order_id","seq")
);
--> statement-breakpoint
CREATE TABLE "cursors" (
	"module" text PRIMARY KEY NOT NULL,
	"start_block" bigint NOT NULL,
	"start_time" bigint,
	"next_block" bigint NOT NULL,
	"tip_hash" text,
	"tip_time" bigint,
	"updated_at_ms" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "events" (
	"module" text NOT NULL,
	"tx_hash" text NOT NULL,
	"log_index" bigint NOT NULL,
	"tx_index" bigint NOT NULL,
	"block_number" bigint NOT NULL,
	"block_hash" text NOT NULL,
	"block_time" bigint NOT NULL,
	"address" text NOT NULL,
	"event" text NOT NULL,
	"args" jsonb,
	"topics" jsonb NOT NULL,
	"data" text NOT NULL,
	CONSTRAINT "events_module_tx_hash_log_index_pk" PRIMARY KEY("module","tx_hash","log_index")
);
--> statement-breakpoint
CREATE TABLE "fee_transfers" (
	"tx_hash" text NOT NULL,
	"log_index" bigint NOT NULL,
	"block_number" bigint NOT NULL,
	"block_time" bigint NOT NULL,
	"from_address" text NOT NULL,
	"to_address" text NOT NULL,
	"value" numeric(78, 0) NOT NULL,
	CONSTRAINT "fee_transfers_tx_hash_log_index_pk" PRIMARY KEY("tx_hash","log_index")
);
--> statement-breakpoint
CREATE TABLE "feeds" (
	"feed_id" text PRIMARY KEY NOT NULL,
	"creator" text NOT NULL,
	"params" jsonb,
	"question_prefix" text,
	"question_tail" text,
	"rounds" bigint NOT NULL,
	"latest_round" bigint,
	"latest_value" numeric(78, 0),
	"latest_time" bigint,
	"funded" numeric(78, 0) NOT NULL,
	"defunded" numeric(78, 0) NOT NULL,
	"spent" numeric(78, 0) NOT NULL,
	"created_block" bigint NOT NULL,
	"created_time" bigint NOT NULL,
	"created_tx" text NOT NULL,
	"updated_block" bigint NOT NULL,
	"updated_time" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "intake_requests" (
	"request_id" text PRIMARY KEY NOT NULL,
	"payer" text,
	"action" text,
	"action_name" text,
	"body_hex" text,
	"body_text" text,
	"body_json" jsonb,
	"question" text,
	"answer_type" text,
	"callback_target" text,
	"callback_selector" text,
	"asset" text,
	"amount" numeric(78, 0),
	"requested_block" bigint,
	"requested_time" bigint,
	"requested_tx" text,
	"requested_log_index" bigint,
	"status" bigint,
	"status_name" text,
	"result_hash" text,
	"uri" text,
	"oracle_request_id" text,
	"delivered" boolean,
	"completed_block" bigint,
	"completed_time" bigint,
	"completed_tx" text,
	"completed_log_index" bigint
);
--> statement-breakpoint
CREATE TABLE "orders" (
	"id" bigint PRIMARY KEY NOT NULL,
	"employer" text NOT NULL,
	"kind_hash" text NOT NULL,
	"spec_hash" text NOT NULL,
	"spec" text NOT NULL,
	"state" text NOT NULL,
	"min_pay" numeric(78, 0) NOT NULL,
	"max_pay" numeric(78, 0) NOT NULL,
	"ramp_secs" bigint NOT NULL,
	"delivery_secs" bigint NOT NULL,
	"expires_at" bigint NOT NULL,
	"bond" numeric(78, 0) NOT NULL,
	"flags" bigint NOT NULL,
	"runner_only" text,
	"arbiter" text,
	"cond_target" text,
	"cond_selector" text,
	"cond_arg" text,
	"cond_cmp" bigint,
	"cond_threshold" numeric(78, 0),
	"triggered_value" numeric(78, 0),
	"claim_seq" bigint,
	"runner" text,
	"price" numeric(78, 0),
	"job_id" text,
	"record_hash" text,
	"proven" boolean,
	"runner_pay" numeric(78, 0),
	"fee" numeric(78, 0),
	"tip" numeric(78, 0),
	"to_employer" numeric(78, 0),
	"agent_ids" jsonb,
	"opened_block" bigint NOT NULL,
	"opened_time" bigint NOT NULL,
	"opened_tx" text NOT NULL,
	"updated_block" bigint NOT NULL,
	"updated_time" bigint NOT NULL,
	"updated_tx" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "payroll_movements" (
	"tx_hash" text NOT NULL,
	"log_index" bigint NOT NULL,
	"block_number" bigint NOT NULL,
	"block_time" bigint NOT NULL,
	"kind" text NOT NULL,
	"account" text,
	"amount" numeric(78, 0) NOT NULL,
	"memo" text,
	"token_id" bigint,
	"agent_id" numeric(78, 0),
	"feed_id" text,
	"detail" jsonb,
	CONSTRAINT "payroll_movements_tx_hash_log_index_pk" PRIMARY KEY("tx_hash","log_index")
);
--> statement-breakpoint
CREATE TABLE "pots" (
	"id" bigint PRIMARY KEY NOT NULL,
	"opener" text NOT NULL,
	"series_id" bigint,
	"spec_hash" text NOT NULL,
	"spec" text,
	"terms" jsonb,
	"deadline" bigint NOT NULL,
	"stage" text NOT NULL,
	"raised" numeric(78, 0) NOT NULL,
	"order_id" bigint,
	"job_id" text,
	"record_hash" text,
	"spent" numeric(78, 0),
	"refundable" numeric(78, 0),
	"opened_block" bigint NOT NULL,
	"opened_time" bigint NOT NULL,
	"opened_tx" text NOT NULL,
	"updated_block" bigint NOT NULL,
	"updated_time" bigint NOT NULL,
	"updated_tx" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "prints" (
	"index" bigint PRIMARY KEY NOT NULL,
	"round" bigint NOT NULL,
	"amount" numeric(78, 0) NOT NULL,
	"from_block" bigint NOT NULL,
	"to_block" bigint NOT NULL,
	"total" numeric(78, 0) NOT NULL,
	"streak" bigint NOT NULL,
	"count" numeric(78, 0),
	"count_round" bigint,
	"best_day" boolean DEFAULT false NOT NULL,
	"printed_block" bigint NOT NULL,
	"printed_time" bigint NOT NULL,
	"printed_tx" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "receipts" (
	"tx_hash" text NOT NULL,
	"log_index" bigint NOT NULL,
	"block_number" bigint NOT NULL,
	"block_time" bigint NOT NULL,
	"job_id" text NOT NULL,
	"job_uuid" text NOT NULL,
	"document_hash" text NOT NULL,
	"previous_hash" text NOT NULL,
	"uri" text NOT NULL,
	CONSTRAINT "receipts_tx_hash_log_index_pk" PRIMARY KEY("tx_hash","log_index")
);
--> statement-breakpoint
CREATE TABLE "rounds" (
	"feed_id" text NOT NULL,
	"round" bigint NOT NULL,
	"status" text NOT NULL,
	"intake_request_id" text NOT NULL,
	"oracle_request_id" text,
	"from_block" bigint NOT NULL,
	"to_block" bigint NOT NULL,
	"question_hash" text NOT NULL,
	"window_block_hash" text,
	"price" numeric(78, 0) NOT NULL,
	"tip" numeric(78, 0) NOT NULL,
	"keeper" text,
	"value" numeric(78, 0),
	"agreed" bigint,
	"delivered_by" text,
	"answer" text,
	"opened_block" bigint NOT NULL,
	"opened_time" bigint NOT NULL,
	"opened_tx" text NOT NULL,
	"closed_block" bigint,
	"closed_time" bigint,
	"closed_tx" text,
	CONSTRAINT "rounds_feed_id_round_pk" PRIMARY KEY("feed_id","round")
);
--> statement-breakpoint
CREATE TABLE "rules" (
	"id" bigint PRIMARY KEY NOT NULL,
	"creator" text NOT NULL,
	"action" text NOT NULL,
	"params" jsonb,
	"spec" text,
	"deposit" numeric(78, 0) NOT NULL,
	"escrow" numeric(78, 0) NOT NULL,
	"fires" bigint NOT NULL,
	"last_fired_time" bigint,
	"last_order_id" bigint,
	"cancelled" boolean DEFAULT false NOT NULL,
	"refund" numeric(78, 0),
	"created_block" bigint NOT NULL,
	"created_time" bigint NOT NULL,
	"created_tx" text NOT NULL,
	"updated_block" bigint NOT NULL,
	"updated_time" bigint NOT NULL
);
--> statement-breakpoint
CREATE INDEX "api_job_records_hash_idx" ON "api_job_records" USING btree ("hash");--> statement-breakpoint
CREATE INDEX "api_jobs_created_idx" ON "api_jobs" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "api_jobs_watched_idx" ON "api_jobs" USING btree ("watched");--> statement-breakpoint
CREATE INDEX "api_oracle_requests_created_idx" ON "api_oracle_requests" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "api_oracle_requests_status_idx" ON "api_oracle_requests" USING btree ("status");--> statement-breakpoint
CREATE INDEX "chips_contributor_idx" ON "chips" USING btree ("contributor");--> statement-breakpoint
CREATE INDEX "claims_runner_idx" ON "claims" USING btree ("runner");--> statement-breakpoint
CREATE INDEX "claims_job_idx" ON "claims" USING btree ("job_id");--> statement-breakpoint
CREATE INDEX "events_module_order_idx" ON "events" USING btree ("module","block_number","log_index");--> statement-breakpoint
CREATE INDEX "events_block_idx" ON "events" USING btree ("block_number");--> statement-breakpoint
CREATE INDEX "fee_transfers_block_idx" ON "fee_transfers" USING btree ("block_number","log_index");--> statement-breakpoint
CREATE INDEX "fee_transfers_time_idx" ON "fee_transfers" USING btree ("block_time");--> statement-breakpoint
CREATE INDEX "fee_transfers_from_idx" ON "fee_transfers" USING btree ("from_address");--> statement-breakpoint
CREATE INDEX "feeds_creator_idx" ON "feeds" USING btree ("creator");--> statement-breakpoint
CREATE INDEX "intake_requests_requested_idx" ON "intake_requests" USING btree ("requested_block","requested_log_index");--> statement-breakpoint
CREATE INDEX "intake_requests_payer_idx" ON "intake_requests" USING btree ("payer");--> statement-breakpoint
CREATE INDEX "intake_requests_callback_idx" ON "intake_requests" USING btree ("callback_target");--> statement-breakpoint
CREATE INDEX "orders_employer_idx" ON "orders" USING btree ("employer");--> statement-breakpoint
CREATE INDEX "orders_state_idx" ON "orders" USING btree ("state");--> statement-breakpoint
CREATE INDEX "orders_job_idx" ON "orders" USING btree ("job_id");--> statement-breakpoint
CREATE INDEX "payroll_movements_block_idx" ON "payroll_movements" USING btree ("block_number","log_index");--> statement-breakpoint
CREATE INDEX "payroll_movements_kind_idx" ON "payroll_movements" USING btree ("kind");--> statement-breakpoint
CREATE INDEX "payroll_movements_account_idx" ON "payroll_movements" USING btree ("account");--> statement-breakpoint
CREATE INDEX "pots_order_idx" ON "pots" USING btree ("order_id");--> statement-breakpoint
CREATE INDEX "pots_opener_idx" ON "pots" USING btree ("opener");--> statement-breakpoint
CREATE INDEX "prints_window_idx" ON "prints" USING btree ("from_block","to_block");--> statement-breakpoint
CREATE INDEX "receipts_job_idx" ON "receipts" USING btree ("job_id","block_number","log_index");--> statement-breakpoint
CREATE INDEX "receipts_block_idx" ON "receipts" USING btree ("block_number","log_index");--> statement-breakpoint
CREATE INDEX "receipts_hash_idx" ON "receipts" USING btree ("document_hash");--> statement-breakpoint
CREATE INDEX "rounds_intake_idx" ON "rounds" USING btree ("intake_request_id");--> statement-breakpoint
CREATE INDEX "rounds_opened_idx" ON "rounds" USING btree ("opened_block");--> statement-breakpoint
CREATE INDEX "rules_creator_idx" ON "rules" USING btree ("creator");