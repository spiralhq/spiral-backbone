CREATE TYPE "public"."access_policy" AS ENUM('Public', 'OrganizationOnly');--> statement-breakpoint
CREATE TYPE "public"."membership_status" AS ENUM('Active', 'Revoked');--> statement-breakpoint
CREATE TYPE "public"."role" AS ENUM('Reader', 'Submitter', 'Admin');--> statement-breakpoint
CREATE TABLE "film_replicas" (
	"film" text NOT NULL,
	"slot" smallint NOT NULL,
	"peer_id" "bytea" NOT NULL,
	"peer_id_len" smallint NOT NULL,
	"declared_at" bigint NOT NULL,
	"active" boolean NOT NULL,
	"indexed_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "film_replicas_film_slot_pk" PRIMARY KEY("film","slot")
);
--> statement-breakpoint
CREATE TABLE "films" (
	"address" text PRIMARY KEY NOT NULL,
	"organization" text NOT NULL,
	"submitter" text NOT NULL,
	"cid" "bytea" NOT NULL,
	"cid_len" smallint NOT NULL,
	"byte_size" bigint NOT NULL,
	"chunking_profile" smallint NOT NULL,
	"title" text NOT NULL,
	"submitted_at" bigint NOT NULL,
	"access_policy" "access_policy" NOT NULL,
	"replica_count" smallint NOT NULL,
	"schema_version" smallint NOT NULL,
	"bump" smallint NOT NULL,
	"indexed_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "memberships" (
	"address" text PRIMARY KEY NOT NULL,
	"organization" text NOT NULL,
	"member" text NOT NULL,
	"role" "role" NOT NULL,
	"status" "membership_status" NOT NULL,
	"granted_by" text NOT NULL,
	"granted_at" bigint NOT NULL,
	"revoked_at" bigint NOT NULL,
	"bump" smallint NOT NULL,
	"indexed_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "organizations" (
	"address" text PRIMARY KEY NOT NULL,
	"authority" text NOT NULL,
	"slug" text NOT NULL,
	"name" text NOT NULL,
	"created_at" bigint NOT NULL,
	"member_count" bigint NOT NULL,
	"schema_version" smallint NOT NULL,
	"bump" smallint NOT NULL,
	"indexed_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sync_cursor" (
	"id" text PRIMARY KEY NOT NULL,
	"slot" bigint NOT NULL,
	"signature" text NOT NULL,
	"indexed_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "film_replicas" ADD CONSTRAINT "film_replicas_film_films_address_fk" FOREIGN KEY ("film") REFERENCES "public"."films"("address") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "films" ADD CONSTRAINT "films_organization_organizations_address_fk" FOREIGN KEY ("organization") REFERENCES "public"."organizations"("address") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memberships" ADD CONSTRAINT "memberships_organization_organizations_address_fk" FOREIGN KEY ("organization") REFERENCES "public"."organizations"("address") ON DELETE no action ON UPDATE no action;