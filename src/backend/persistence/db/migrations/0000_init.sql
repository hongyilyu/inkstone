CREATE TABLE `agent_messages` (
	`id` text PRIMARY KEY NOT NULL,
	`session_id` text NOT NULL,
	`display_message_id` text,
	`data` text NOT NULL,
	FOREIGN KEY (`session_id`) REFERENCES `sessions`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`display_message_id`) REFERENCES `messages`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `agent_messages_session_id_idx` ON `agent_messages` (`session_id`,`id`);--> statement-breakpoint
CREATE INDEX `agent_messages_display_idx` ON `agent_messages` (`display_message_id`);--> statement-breakpoint
CREATE TABLE `messages` (
	`id` text PRIMARY KEY NOT NULL,
	`session_id` text NOT NULL,
	`role` text NOT NULL,
	`agent_name` text,
	`model_name` text,
	`duration_ms` integer,
	`thinking_level` text,
	`error` text,
	`interrupted` integer,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`session_id`) REFERENCES `sessions`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `messages_session_id_idx` ON `messages` (`session_id`,`id`);--> statement-breakpoint
CREATE TABLE `parts` (
	`message_id` text NOT NULL,
	`seq` integer NOT NULL,
	`type` text NOT NULL,
	`text` text NOT NULL,
	`mime` text,
	`filename` text,
	`call_id` text,
	`tool_data` text,
	PRIMARY KEY(`message_id`, `seq`),
	FOREIGN KEY (`message_id`) REFERENCES `messages`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `sessions` (
	`id` text PRIMARY KEY NOT NULL,
	`started_at` integer NOT NULL,
	`agent` text NOT NULL,
	`title` text
);
