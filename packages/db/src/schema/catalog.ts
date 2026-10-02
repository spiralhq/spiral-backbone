import {
  bigint,
  boolean,
  pgEnum,
  pgTable,
  primaryKey,
  smallint,
  text,
  timestamp,
} from "drizzle-orm/pg-core";
import { bytea } from "./columns";

export const roleEnum = pgEnum("role", ["Reader", "Submitter", "Admin"]);
export const membershipStatusEnum = pgEnum("membership_status", ["Active", "Revoked"]);
export const accessPolicyEnum = pgEnum("access_policy", ["Public", "OrganizationOnly"]);

const indexedAt = () => timestamp("indexed_at", { withTimezone: true }).notNull().defaultNow();

export const organizations = pgTable("organizations", {
  address: text("address").primaryKey(),
  authority: text("authority").notNull(),
  slug: text("slug").notNull(),
  name: text("name").notNull(),
  createdAt: bigint("created_at", { mode: "bigint" }).notNull(),
  memberCount: bigint("member_count", { mode: "number" }).notNull(),
  schemaVersion: smallint("schema_version").notNull(),
  bump: smallint("bump").notNull(),
  indexedAt: indexedAt(),
});

export const memberships = pgTable("memberships", {
  address: text("address").primaryKey(),
  organization: text("organization")
    .notNull()
    .references(() => organizations.address),
  member: text("member").notNull(),
  role: roleEnum("role").notNull(),
  status: membershipStatusEnum("status").notNull(),
  grantedBy: text("granted_by").notNull(),
  grantedAt: bigint("granted_at", { mode: "bigint" }).notNull(),
  revokedAt: bigint("revoked_at", { mode: "bigint" }).notNull(),
  bump: smallint("bump").notNull(),
  indexedAt: indexedAt(),
});

export const films = pgTable("films", {
  address: text("address").primaryKey(),
  organization: text("organization")
    .notNull()
    .references(() => organizations.address),
  submitter: text("submitter").notNull(),
  cid: bytea("cid").notNull(),
  cidLen: smallint("cid_len").notNull(),
  byteSize: bigint("byte_size", { mode: "bigint" }).notNull(),
  chunkingProfile: smallint("chunking_profile").notNull(),
  title: text("title").notNull(),
  submittedAt: bigint("submitted_at", { mode: "bigint" }).notNull(),
  accessPolicy: accessPolicyEnum("access_policy").notNull(),
  replicaCount: smallint("replica_count").notNull(),
  schemaVersion: smallint("schema_version").notNull(),
  bump: smallint("bump").notNull(),
  indexedAt: indexedAt(),
});

export const filmReplicas = pgTable(
  "film_replicas",
  {
    film: text("film")
      .notNull()
      .references(() => films.address),
    slot: smallint("slot").notNull(),
    peerId: bytea("peer_id").notNull(),
    peerIdLen: smallint("peer_id_len").notNull(),
    declaredAt: bigint("declared_at", { mode: "bigint" }).notNull(),
    active: boolean("active").notNull(),
    indexedAt: indexedAt(),
  },
  (table) => [primaryKey({ columns: [table.film, table.slot] })],
);

export const syncCursor = pgTable("sync_cursor", {
  id: text("id").primaryKey(),
  slot: bigint("slot", { mode: "bigint" }).notNull(),
  signature: text("signature").notNull(),
  indexedAt: indexedAt(),
});

type WithoutIndexedAt<T> = Omit<T, "indexedAt">;

export type OrganizationRecord = WithoutIndexedAt<typeof organizations.$inferSelect>;
export type MembershipRecord = WithoutIndexedAt<typeof memberships.$inferSelect>;
export type FilmRecord = WithoutIndexedAt<typeof films.$inferSelect>;
export type FilmReplicaRecord = WithoutIndexedAt<typeof filmReplicas.$inferSelect>;

export interface CatalogSnapshot {
  organizations: OrganizationRecord[];
  memberships: MembershipRecord[];
  films: FilmRecord[];
  filmReplicas: FilmReplicaRecord[];
}
