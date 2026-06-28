// Drizzle schema — the single source of truth for the database structure.
// Mirrors the live Postgres schema exactly. Generate migrations with:
//   npx drizzle-kit generate     (diffs this file against ./src/server/drizzle)
// and they are applied automatically on boot (see db.ts → init()).
// Epoch-ms timestamps are BIGINT with mode:'number' (node-postgres BIGINT parser is
// set to Number in db.ts, so values round-trip as JS numbers).
import { pgTable, text, integer, bigint, boolean, smallint, uniqueIndex, index } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';

const ms = (name: string) => bigint(name, { mode: 'number' });

export const users = pgTable('users', {
  id: text('id').primaryKey(),
  email: text('email').notNull().unique(),
  passwordHash: text('password_hash'),
  displayName: text('display_name'),
  emailVerifiedAt: ms('email_verified_at'),
  plan: text('plan').notNull().default('free'),
  stripeCustomerId: text('stripe_customer_id'),
  isAdmin: boolean('is_admin').notNull().default(false),  // site admin (bootstrapped from ADMIN_EMAIL env)
  createdAt: ms('created_at').notNull(),
});

export const authIdentities = pgTable('auth_identities', {
  id: text('id').primaryKey(),
  userId: text('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  provider: text('provider').notNull(),
  providerUserId: text('provider_user_id').notNull(),
  createdAt: ms('created_at').notNull(),
}, (t) => ({
  providerUnique: uniqueIndex('auth_identities_provider_provider_user_id_key').on(t.provider, t.providerUserId),
  userIdx: index('idx_auth_identities_user').on(t.userId),
}));

export const emailTokens = pgTable('email_tokens', {
  id: text('id').primaryKey(),
  userId: text('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  purpose: text('purpose').notNull(),
  tokenHash: text('token_hash').notNull(),
  expiresAt: ms('expires_at').notNull(),
  consumedAt: ms('consumed_at'),
  createdAt: ms('created_at').notNull(),
}, (t) => ({
  hashIdx: index('idx_email_tokens_hash').on(t.tokenHash),
  userIdx: index('idx_email_tokens_user').on(t.userId),
}));

export const sessions = pgTable('sessions', {
  id: text('id').primaryKey(),
  userId: text('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  expiresAt: ms('expires_at').notNull(),
  userAgent: text('user_agent'),
  createdAt: ms('created_at').notNull(),
}, (t) => ({
  userIdx: index('idx_sessions_user').on(t.userId),
}));

export const events = pgTable('events', {
  id: text('id').primaryKey(),
  ownerUserId: text('owner_user_id').references(() => users.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),
  blurb: text('blurb'),                                     // optional welcome line shown under the title on the join screen
  joinCode: text('join_code').notNull().unique(),
  slug: text('slug'),
  organizerCode: text('organizer_code').notNull(),
  maxPhotos: integer('max_photos').notNull().default(24),
  revealMode: text('reveal_mode').notNull().default('instant'),
  revealDelayHours: integer('reveal_delay_hours').notNull().default(0),
  moderationEnabled: boolean('moderation_enabled').notNull().default(false),
  startsAt: ms('starts_at').notNull(),
  expiresAt: ms('expires_at').notNull(),
  revealedAt: ms('revealed_at'),
  revealHidden: boolean('reveal_hidden').notNull().default(false),  // organizer "Hide photos" override — wins over mode/time
  isLocked: boolean('is_locked').notNull().default(false),
  allowDownloads: boolean('allow_downloads').notNull().default(true),
  noFlash: boolean('no_flash').notNull().default(false),    // organizer disables the back-camera LED flash for guests
  theme: text('theme'),
  timezone: text('timezone'),
  aspectRatios: text('aspect_ratios').default('["1:1"]'),
  ratingMode: text('rating_mode').notNull().default('favourite'),
  // Billing entitlement (per-event). Only enforced when billingEnabled; ignored self-host.
  guestCap: integer('guest_cap').notNull().default(10),     // max participants this event is entitled to
  videoSeconds: integer('video_seconds').notNull().default(0), // allowed video length (0 = none)
  retentionDays: integer('retention_days').notNull().default(7), // how long photos are kept after the event ends
  paid: boolean('paid').notNull().default(false),           // payment completed (paid tiers only)
  amountPaidCents: integer('amount_paid_cents').notNull().default(0), // total paid so far (for upgrade top-ups)
  brandingRemovalPaid: boolean('branding_removal_paid').notNull().default(false), // bought the $1 "no Snapdini frames" slideshow add-on
  posterConfig: text('poster_config'),                      // saved poster designer customisation (JSON)
  purgeAt: ms('purge_at'),
  // Retention-end archive: when purged, media + participant rows are deleted but a slim
  // record (settings + these final stats) is kept for the organizer's history.
  purgedAt: ms('purged_at'),
  statParticipants: integer('stat_participants').notNull().default(0),
  statPhotos: integer('stat_photos').notNull().default(0),
  createdAt: ms('created_at').notNull(),
}, (t) => ({
  slugIdx: uniqueIndex('idx_events_slug').on(t.slug).where(sql`${t.slug} IS NOT NULL`),
  ownerIdx: index('idx_events_owner').on(t.ownerUserId).where(sql`${t.ownerUserId} IS NOT NULL`),
}));

export const participants = pgTable('participants', {
  id: text('id').primaryKey(),
  eventId: text('event_id').notNull().references(() => events.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),
  email: text('email'),
  sessionToken: text('session_token').notNull().unique(),
  photosTaken: integer('photos_taken').notNull().default(0),
  joinedAt: ms('joined_at').notNull(),
}, (t) => ({
  eventIdx: index('idx_participants_event').on(t.eventId),
}));

export const photos = pgTable('photos', {
  id: text('id').primaryKey(),
  eventId: text('event_id').notNull().references(() => events.id, { onDelete: 'cascade' }),
  participantId: text('participant_id').notNull().references(() => participants.id, { onDelete: 'cascade' }),
  filename: text('filename').notNull(),
  mediaType: text('media_type').notNull().default('photo'),
  takenAt: ms('taken_at').notNull(),
  isHighlighted: boolean('is_highlighted').notNull().default(false),
  status: text('status').notNull().default('approved'),
  rating: smallint('rating').notNull().default(0),
  // Display metadata (nullable — legacy rows have none): byte size, pixel dimensions, video length.
  sizeBytes: bigint('size_bytes', { mode: 'number' }),
  width: integer('width'),
  height: integer('height'),
  durationMs: integer('duration_ms'),
}, (t) => ({
  eventIdx: index('idx_photos_event').on(t.eventId),
  eventStatusIdx: index('idx_photos_event_status').on(t.eventId, t.status),
  eventTakenIdx: index('idx_photos_event_taken').on(t.eventId, t.takenAt),
  participantIdx: index('idx_photos_participant').on(t.participantId),
}));

// Shareable links to a gallery: 'all' = the whole (visible) library, 'selected' = a hand-picked
// subset (photoIds). Each has its own opaque token so an organizer can share a curated set.
export const shares = pgTable('shares', {
  id: text('id').primaryKey(),                 // opaque share token (fallback URL segment)
  eventId: text('event_id').notNull().references(() => events.id, { onDelete: 'cascade' }),
  kind: text('kind').notNull().default('all'), // 'all' | 'favourites' | 'selected'
  photoIds: text('photo_ids'),                 // JSON array of photo ids (for 'selected')
  label: text('label'),                        // human name for the share (organizer-editable)
  slug: text('slug'),                          // pretty URL segment (/s/<slug>); editable, globally unique
  createdAt: ms('created_at').notNull(),
}, (t) => ({
  slugIdx: uniqueIndex('idx_shares_slug').on(t.slug).where(sql`${t.slug} IS NOT NULL`),
}));

// Generated slideshow exports. Versioned (one row per generation) so an organizer keeps a few
// recent renders to compare/revert. Non-favourite ones auto-purge after a short while; favourited
// ones are kept for the event's full photo-retention window.
export const slideshows = pgTable('slideshows', {
  id: text('id').primaryKey(),                  // token (also the filename stem + URL segment)
  eventId: text('event_id').notNull().references(() => events.id, { onDelete: 'cascade' }),
  filename: text('filename').notNull(),         // path relative to the uploads dir
  favourite: boolean('favourite').notNull().default(false),
  label: text('label'),                         // short human label (e.g. "Favourites · 3s")
  resolution: text('resolution').notNull().default('4k'),   // '4k' | '1080p' — drives the "also get 1080p" download
  createdAt: ms('created_at').notNull(),
});

// Co-hosts: people the owner invites (by email) to manage an event as if they owned it. Once a
// co-host accepts (signs in / creates an account), they get the same identity-based management
// access as the owner. The original creator (events.ownerUserId) is NEVER a row here, so they can
// never be removed via co-host management.
export const eventCohosts = pgTable('event_cohosts', {
  id: text('id').primaryKey(),
  eventId: text('event_id').notNull().references(() => events.id, { onDelete: 'cascade' }),
  email: text('email').notNull(),                              // invited email (lowercased)
  userId: text('user_id').references(() => users.id, { onDelete: 'cascade' }),  // set when accepted
  status: text('status').notNull().default('invited'),         // 'invited' | 'accepted'
  token: text('token').notNull(),                              // accept-link secret
  invitedByUserId: text('invited_by_user_id'),
  createdAt: ms('created_at').notNull(),
  acceptedAt: ms('accepted_at'),
}, (t) => ({
  eventIdx: index('idx_cohosts_event').on(t.eventId),
  userIdx: index('idx_cohosts_user').on(t.userId),
  tokenIdx: uniqueIndex('idx_cohosts_token').on(t.token),
  emailLowerIdx: index('idx_cohosts_email_lower').on(sql`lower(${t.email})`),
}));

// Contact-form submissions. Always stored (DB-backed mailbox) so messages are never lost if
// email is unconfigured or sending fails; surfaced in the site-admin page.
export const contactMessages = pgTable('contact_messages', {
  id: text('id').primaryKey(),
  name: text('name'),
  email: text('email'),
  message: text('message').notNull(),
  emailed: boolean('emailed').notNull().default(false), // was the support email delivered?
  handled: boolean('handled').notNull().default(false), // admin marked as dealt-with
  createdAt: ms('created_at').notNull(),
});

// Client-side diagnostic/error reports (e.g. a failed upload) — TECHNICAL data only, no photos
// or personal content. Surfaced in site-admin so we can actually see guest-side failures.
export const clientErrors = pgTable('client_errors', {
  id: text('id').primaryKey(),
  message: text('message').notNull(),
  context: text('context'),       // where it happened, e.g. 'upload' / 'camera'
  eventCode: text('event_code'),  // join code, if known
  userAgent: text('user_agent'),
  url: text('url'),               // page path
  handled: boolean('handled').notNull().default(false),
  createdAt: ms('created_at').notNull(),
});

// Inferred row types — use these to type query results across the backend.
export type User = typeof users.$inferSelect;
export type AuthIdentity = typeof authIdentities.$inferSelect;
export type EmailToken = typeof emailTokens.$inferSelect;
export type Session = typeof sessions.$inferSelect;
export type Event = typeof events.$inferSelect;
export type Participant = typeof participants.$inferSelect;
export type Photo = typeof photos.$inferSelect;
