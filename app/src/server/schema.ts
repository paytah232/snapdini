// Drizzle schema — the single source of truth for the database structure.
// Mirrors the live Postgres schema exactly. Generate migrations with:
//   npx drizzle-kit generate     (diffs this file against ./src/server/drizzle)
// and they are applied automatically on boot (see db.ts → init()).
// Epoch-ms timestamps are BIGINT with mode:'number' (node-postgres BIGINT parser is
// set to Number in db.ts, so values round-trip as JS numbers).
import { pgTable, text, integer, bigint, bigserial, jsonb, boolean, smallint, real, primaryKey, uniqueIndex, index } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';

const ms = (name: string) => bigint(name, { mode: 'number' });

export const users = pgTable('users', {
  id: text('id').primaryKey(),
  email: text('email').notNull().unique(),
  passwordHash: text('password_hash'),
  displayName: text('display_name'),
  emailVerifiedAt: ms('email_verified_at'),
  plan: text('plan').notNull().default('free'),
  // Guest-referral attribution, stamped from the `ref` cookie at signup. A guest may sign up long
  // before they run anything, so this is captured separately from the per-event stamp.
  referredByEventId: text('referred_by_event_id'),
  stripeCustomerId: text('stripe_customer_id'),
  isAdmin: boolean('is_admin').notNull().default(false),  // site admin (bootstrapped from ADMIN_EMAIL env)
  // Account lifecycle email guards (see lifecycle.ts) — one-shot, prevent double-sends.
  accountWelcomeSentAt: ms('account_welcome_sent_at'),
  activationNudgeSentAt: ms('activation_nudge_sent_at'),
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

// Per-ACCOUNT email opt-outs. A ROW MEANS OPTED OUT — there is no subscribed row and no boolean to
// read the wrong way round, so an account with no rows here receives everything, which is every
// account that existed before the table did.
//
// Keyed to the user rather than an event on purpose: asking us to stop sending a kind of message is
// a standing instruction from a recipient, not a setting on one party. See 0045_email_preferences.
export const emailPreferences = pgTable('email_preferences', {
  userId: text('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  kind: text('kind').notNull(),             // the builder name in lifecycle-emails.ts, e.g. 'surveyEmail'
  optedOutAt: ms('opted_out_at').notNull(), // when they asked — the record of the request itself
}, (t) => ({ pk: primaryKey({ columns: [t.userId, t.kind] }) }));

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
  // What guests may buy for themselves. Shots default ON (more shots are invisible to everyone
  // else); video and frames default OFF, because both change what appears in the host's gallery.
  guestMayBuyShots: boolean('guest_may_buy_shots').notNull().default(true),
  guestMayBuyVideo: boolean('guest_may_buy_video').notNull().default(false),
  guestMayBuyFrames: boolean('guest_may_buy_frames').notNull().default(false),
  // Separate from buying: a host may take top-ups yet not want request notices, or vice versa.
  guestMayRequest: boolean('guest_may_request').notNull().default(true),
  // Off by default: a self-hoster who has not thought about biometrics gets no face matching.
  faceMatchingEnabled: boolean('face_matching_enabled').notNull().default(false),
  revealMode: text('reveal_mode').notNull().default('instant'),
  revealDelayHours: integer('reveal_delay_hours').notNull().default(0),
  // An exact instant the host picked instead of a delay off the end (see shared/reveal.ts).
  // Absolute rather than derived: a delay is anchored to expires_at, so rescheduling the event
  // would drag a date the host chose on purpose to a different day. NULL means fall back to
  // reveal_delay_hours — which is every event that existed before this column.
  revealAt: ms('reveal_at'),
  moderationEnabled: boolean('moderation_enabled').notNull().default(false),
  startsAt: ms('starts_at').notNull(),
  // Anchor for the reschedule window: the start this event was FIRST created with.
  // Bounds how far an unused event may be moved (see 0026_event_reschedule).
  originalStartsAt: ms('original_starts_at'),
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
  eventType: text('event_type'),                            // wedding | birthday | … | NULL = unstated
  challenges: text('challenges'),                           // chosen photo missions (JSON [{id,text}])
  purgeAt: ms('purge_at'),
  // Retention-end archive: when purged, media + participant rows are deleted but a slim
  // record (settings + these final stats) is kept for the organizer's history.
  purgedAt: ms('purged_at'),
  statParticipants: integer('stat_participants').notNull().default(0),
  statPhotos: integer('stat_photos').notNull().default(0),
  // Customer lifecycle emails — one-shot guards so nothing double-sends (see lifecycle.ts).
  welcomeSentAt: ms('welcome_sent_at'),
  checkinSentAt: ms('checkin_sent_at'),
  feedbackSentAt: ms('feedback_sent_at'),
  surveyToken: text('survey_token'),                        // unguessable token for the post-event survey page
  stripePaymentIntent: text('stripe_payment_intent'),       // captured at payment; enables one-click refund
  refundedAt: ms('refunded_at'),                            // set when the operator refunds the event
  // ── Guest referral funnel ──────────────────────────────────────────────────
  referredByEventId: text('referred_by_event_id'),          // whose gallery sent this host here
  galleryViews: integer('gallery_views').notNull().default(0),
  referralClicks: integer('referral_clicks').notNull().default(0),
  // Single-use Stripe promotion code issued to the host for their NEXT event (~90 days).
  hostRewardCode: text('host_reward_code'),
  hostRewardExpiresAt: ms('host_reward_expires_at'),
  hostRewardSentAt: ms('host_reward_sent_at'),
  // ── Guest delivery: getting the photos to the people who took them ─────────
  // See drizzle/0046_guest_delivery.sql. Nothing here can email an existing event's guests: the
  // consent gate is participants.wantsPhotos, which is false on every row that already exists.
  // 'all_on_reveal' | 'favourites_manual' | 'scheduled' | 'manual' — WHEN the gallery link goes.
  guestDelivery: text('guest_delivery').notNull().default('all_on_reveal'),
  // 'all' | 'favourites' — WHICH photos that link shows. Separate from the mode, so "favourites,
  // automatically at reveal" and "everything, by hand" are both sayable.
  guestSendScope: text('guest_send_scope').notNull().default('all'),
  // The instant for 'scheduled'. NEVER earlier than the reveal — a gallery link that lands before
  // the gallery opens sends a guest to a locked page. Clamped up on write, re-checked at send.
  guestSendAt: ms('guest_send_at'),
  // One-shot guards, claimed atomically the way welcomeSentAt is. Three of them, because the three
  // guest messages are three occasions: the guard that stops the link going twice must not also
  // stop the thank-you that precedes it.
  guestsSentAt: ms('guests_sent_at'),                 // the gallery link
  guestThanksSentAt: ms('guest_thanks_sent_at'),      // the event-end message
  guestReminderSentAt: ms('guest_reminder_sent_at'),  // "photos release tomorrow"
  // Which of the three the host wants. The day-before reminder is off by default — it is the one
  // that is noise for most events, and nobody should have to turn it off.
  //
  // guestMailThanks does NOT decide whether a guest who asked for their photos hears from us at the
  // end: they asked, and that consent stands on its own. It decides whether that one message is
  // also a thank-you carrying the release date.
  guestMailThanks: boolean('guest_mail_thanks').notNull().default(true),
  guestMailReminder: boolean('guest_mail_reminder').notNull().default(false),
  guestMailLive: boolean('guest_mail_live').notNull().default(true),
  createdAt: ms('created_at').notNull(),
}, (t) => ({
  slugIdx: uniqueIndex('idx_events_slug').on(t.slug).where(sql`${t.slug} IS NOT NULL`),
  ownerIdx: index('idx_events_owner').on(t.ownerUserId).where(sql`${t.ownerUserId} IS NOT NULL`),
  surveyTokenIdx: uniqueIndex('idx_events_survey_token').on(t.surveyToken).where(sql`${t.surveyToken} IS NOT NULL`),
}));

// Small key/value store for operational state (last ops digest date, alert cooldowns, etc.).
export const appState = pgTable('app_state', {
  key: text('key').primaryKey(),
  value: text('value').notNull(),
  updatedAt: ms('updated_at').notNull(),
});

// Post-event feedback survey responses. One row per submission (an organizer may resubmit; we keep all).
export const surveyResponses = pgTable('survey_responses', {
  id: text('id').primaryKey(),
  eventId: text('event_id').notNull().references(() => events.id, { onDelete: 'cascade' }),
  overall: smallint('overall'),                             // 1–5
  setup: smallint('setup'),                                 // 1–5
  guestExperience: smallint('guest_experience'),            // 1–5
  value: smallint('value'),                                 // 1–5
  nps: smallint('nps'),                                     // 0–10
  comments: text('comments'),                               // JSON blob of optional per-question + overall comments
  contactOptIn: boolean('contact_opt_in').notNull().default(false),
  // Consent to be QUOTED publicly — deliberately separate from contactOptIn, which is only consent
  // to be contacted. Asked only when the score is high enough that it is a reasonable request.
  testimonialOk: boolean('testimonial_ok').notNull().default(false),
  testimonialName: text('testimonial_name'),
  publishedAt: ms('published_at'),            // set when the operator actually publishes it
  createdAt: ms('created_at').notNull(),
}, (t) => ({
  eventIdx: index('idx_survey_event').on(t.eventId),
}));

export const participants = pgTable('participants', {
  id: text('id').primaryKey(),
  eventId: text('event_id').notNull().references(() => events.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),
  email: text('email'),
  sessionToken: text('session_token').notNull().unique(),
  photosTaken: integer('photos_taken').notNull().default(0),
  // Bought by the guest for THEMSELVES, on top of the event's roll — never a replacement, so a
  // host lowering the event roll cannot remove something a guest paid for.
  extraPhotos: integer('extra_photos').notNull().default(0),
  upgradeEmail: text('upgrade_email'),
  challengeSet: text('challenge_set'),                      // which mission card this guest was handed
  amountPaidCents: integer('amount_paid_cents').notNull().default(0),
  stripePaymentIntent: text('stripe_payment_intent'),
  requestedMoreAt: ms('requested_more_at'),
  // The enrolled guest's OWN template, with their consent. Sensitive information — never returned
  // by any API, and the only face vector this system persists.
  faceEmbedding: text('face_embedding'),
  faceConsentAt: ms('face_consent_at'),
  feedbackAskedAt: ms('feedback_asked_at'),
  // The guest asked us to send them the photos. THE consent gate for every guest email — false on
  // every row that predates it, which is why no existing event's guests can be mailed.
  wantsPhotos: boolean('wants_photos').notNull().default(false),
  joinedAt: ms('joined_at').notNull(),
}, (t) => ({
  eventIdx: index('idx_participants_event').on(t.eventId),
  // The sweep's only read of this table: the guests at one event who asked and left an address.
  wantsPhotosIdx: index('idx_participants_wants_photos').on(t.eventId)
    .where(sql`${t.wantsPhotos} AND ${t.email} IS NOT NULL`),
}));

export const photos = pgTable('photos', {
  id: text('id').primaryKey(),
  eventId: text('event_id').notNull().references(() => events.id, { onDelete: 'cascade' }),
  participantId: text('participant_id').notNull().references(() => participants.id, { onDelete: 'cascade' }),
  filename: text('filename').notNull(),
  mediaType: text('media_type').notNull().default('photo'),
  challengeId: text('challenge_id'),                        // the photo mission this shot satisfied
  // A caption written under the photo — the guest's own "cute message", or the host's. Kept apart
  // from challengeId so a captioned trick shot can show both (see 0040_photo_captions.sql).
  // NULL, never '', is how "no caption" is stored.
  caption: text('caption'),
  takenAt: ms('taken_at').notNull(),
  isHighlighted: boolean('is_highlighted').notNull().default(false),
  status: text('status').notNull().default('approved'),
  rating: smallint('rating').notNull().default(0),
  // Display metadata (nullable — legacy rows have none): byte size, pixel dimensions, video length.
  sizeBytes: bigint('size_bytes', { mode: 'number' }),
  width: integer('width'),
  height: integer('height'),
  durationMs: integer('duration_ms'),
  // 'capture' (shot in-app) | 'upload' (camera roll). Null for rows predating the column.
  source: text('source'),
  // 'portrait' | 'landscape' | 'unknown' — how the phone was HELD, which the pixels cannot say when
  // rotation lock keeps a sideways shot in a portrait-shaped frame. See 0042_capture_orientation.sql.
  captureOrientation: text('capture_orientation'),
  // The shape the guest CHOSE ('1:1', '4:5', 'full'…). Only meaningful for clips, where asking the
  // camera for a shape frequently does not get you one. See 0043_capture_shape.sql.
  captureShape: text('capture_shape'),
  // Gallery engagement. Counters, not an events table — at this volume they answer every question
  // we have without unbounded growth.
  viewCount: integer('view_count').notNull().default(0),
  downloadCount: integer('download_count').notNull().default(0),
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

// Who a link has actually been emailed to — for BOTH the standing gallery link (shareId null) and
// the curated shares a host creates. See drizzle/0041_share_sends.sql for why it is one table.
//
// `ok: false` rows are kept rather than dropped: a send that failed is precisely what the host
// needs to see, and deleting it would leave the list quietly claiming everything went out.
export const shareSends = pgTable('share_sends', {
  id: text('id').primaryKey(),
  eventId: text('event_id').notNull().references(() => events.id, { onDelete: 'cascade' }),
  shareId: text('share_id').references(() => shares.id, { onDelete: 'cascade' }),  // null = gallery link
  email: text('email').notNull(),
  ok: boolean('ok').notNull().default(true),
  sentAt: ms('sent_at').notNull(),
}, (t) => ({
  eventIdx: index('idx_share_sends_event').on(t.eventId, t.sentAt),
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
  kind: text('kind').notNull().default('contact'), // 'contact' | 'bug' | 'feedback' | 'suggestion'
  imageFilename: text('image_filename'),           // optional screenshot (relative to UPLOADS_DIR, under feedback/)
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
export type EmailPreference = typeof emailPreferences.$inferSelect;
export type Event = typeof events.$inferSelect;
export type Participant = typeof participants.$inferSelect;
export type Photo = typeof photos.$inferSelect;

// Which enrolled guest appears in which photo. This is the durable output of face matching and is
// deliberately NOT a biometric template — just an association between two rows we already hold.
export const photoFaces = pgTable('photo_faces', {
  photoId: text('photo_id').notNull().references(() => photos.id, { onDelete: 'cascade' }),
  participantId: text('participant_id').notNull().references(() => participants.id, { onDelete: 'cascade' }),
  score: real('score').notNull(),
  createdAt: ms('created_at').notNull(),
}, (t) => ({ pk: primaryKey({ columns: [t.photoId, t.participantId] }) }));

// How it felt to USE the thing, from the people who used it. Separate from the host's survey and
// from support: a different respondent, a different question.
/**
 * First-party product analytics. See 0037.
 *
 * `visit` is a daily-rotating, non-reversible hash — it exists so a funnel can be counted per
 * visit, not so anyone can be followed. No device storage, no cross-day identity, no raw IP.
 * `eventId` has no foreign key on purpose: analytics has to outlive the retention purge that
 * deletes the event it refers to.
 */
export const siteEvents = pgTable('site_events', {
  id:        bigserial('id', { mode: 'number' }).primaryKey(),
  name:      text('name').notNull(),
  path:      text('path'),
  visit:     text('visit'),
  eventId:   text('event_id'),
  props:     jsonb('props').notNull().default({}),
  createdAt: ms('created_at').notNull(),
});

export const guestFeedback = pgTable('guest_feedback', {
  id: text('id').primaryKey(),
  eventId: text('event_id').notNull().references(() => events.id, { onDelete: 'cascade' }),
  // Nullable on purpose: the retention purge detaches feedback from the guest rather than
  // deleting it, so the rating survives anonymously. See 0035.
  participantId: text('participant_id').references(() => participants.id, { onDelete: 'set null' }),
  rating: smallint('rating'),
  comment: text('comment'),
  createdAt: ms('created_at').notNull(),
});

// ── Guest list + invites ─────────────────────────────────────────────────────
// See 0044_guest_invites.sql for the full reasoning. In short: event_guests is WHO, guest_invites
// is WHAT HAPPENED to one message, and email_suppressions is WHO MUST NEVER BE MAILED AGAIN.

/** A person the host means to invite. Everything but the event is optional — a real guest list has
 *  rows with a phone and no email, and rows that are just a name. A row with no email is simply
 *  not mailable; it is still part of the list. */
export const eventGuests = pgTable('event_guests', {
  id: text('id').primaryKey(),
  eventId: text('event_id').notNull().references(() => events.id, { onDelete: 'cascade' }),
  name: text('name'),
  /** Lower-cased and trimmed on write. The partial unique index below is a byte comparison, so
   *  normalising here is what actually stops the same spreadsheet importing twice. */
  email: text('email'),
  phone: text('phone'),
  notes: text('notes'),
  createdAt: ms('created_at').notNull(),
  updatedAt: ms('updated_at').notNull(),
}, (t) => ({
  eventIdx: index('idx_event_guests_event').on(t.eventId, t.createdAt),
  emailUnique: uniqueIndex('idx_event_guests_event_email').on(t.eventId, t.email).where(sql`${t.email} IS NOT NULL`),
}));

/** One invite email, to one address. Written at send time, then updated by the provider's webhook
 *  as the outside world reports back. */
export const guestInvites = pgTable('guest_invites', {
  id: text('id').primaryKey(),
  eventId: text('event_id').notNull().references(() => events.id, { onDelete: 'cascade' }),
  /** SET NULL so removing a guest does not erase the record that we mailed them. */
  guestId: text('guest_id').references(() => eventGuests.id, { onDelete: 'set null' }),
  email: text('email').notNull(),
  /** 'sent' | 'delivered' | 'bounced' | 'complained' | 'unsubscribed' | 'failed'.
   *  'sent' means handed over and nothing heard since — which is the FINAL state on a transport
   *  that cannot report back, and only a waypoint on one that can. `provider` distinguishes them. */
  status: text('status').notNull().default('sent'),
  provider: text('provider'),                              // 'mailgun' | 'smtp'
  /** Our correlation id, attached to the message and echoed back by the webhook. Minted before the
   *  send, so it exists even if the provider's response never arrives. */
  token: text('token').notNull(),
  providerMessageId: text('provider_message_id'),
  reason: text('reason'),                                  // the provider's words, shown verbatim
  severity: text('severity'),                              // 'permanent' | 'temporary', as reported
  sentAt: ms('sent_at').notNull(),
  updatedAt: ms('updated_at').notNull(),
  /** The PROVIDER's timestamp for the event that last changed the status. Webhooks arrive out of
   *  order, so this — not our clock — is what decides whether an arriving event is newer. */
  eventAt: ms('event_at'),
}, (t) => ({
  eventIdx: index('idx_guest_invites_event').on(t.eventId, t.sentAt),
  tokenUnique: uniqueIndex('idx_guest_invites_token').on(t.token),
  messageIdx: index('idx_guest_invites_message').on(t.providerMessageId).where(sql`${t.providerMessageId} IS NOT NULL`),
  guestIdx: index('idx_guest_invites_guest').on(t.guestId, t.sentAt).where(sql`${t.guestId} IS NOT NULL`),
}));

/** Addresses this deployment must not mail again, deployment-wide rather than per event.
 *
 *  Sending reputation belongs to the DOMAIN: an address that hard-bounced at one party is just as
 *  dead at the next, and mailing it again is what gets a domain throttled and then blocked — after
 *  which nothing reaches anybody. The address is the primary key so a redelivered webhook upserts
 *  instead of accumulating rows. */
export const emailSuppressions = pgTable('email_suppressions', {
  email: text('email').primaryKey(),                       // lower-cased
  reason: text('reason').notNull(),                        // 'bounced' | 'complained' | 'unsubscribed' | 'manual'
  detail: text('detail'),
  createdAt: ms('created_at').notNull(),
});

/** What a guest asked us to stop sending. See 0048_guest_unsubscribes.sql.
 *
 *  Keyed by (event, address) rather than by guest id: the request belongs to the ADDRESS, and a
 *  host who deletes a guest and re-imports their spreadsheet must not resurrect someone who
 *  already said stop. A 'all'-scoped row is mirrored into emailSuppressions — that is the table
 *  the send paths consult — and this row records that it was a request rather than a bounce. */
export const guestUnsubscribes = pgTable('guest_unsubscribes', {
  eventId: text('event_id').notNull().references(() => events.id, { onDelete: 'cascade' }),
  email: text('email').notNull(),                          // lower-cased
  scope: text('scope').notNull(),                          // 'event' | 'all'
  source: text('source').notNull(),                        // 'one-click' | 'page'
  inviteToken: text('invite_token'),
  /** Asked for AFTER the unsubscribe has taken effect, never as a condition of it. */
  feedbackReason: text('feedback_reason'),
  feedbackComment: text('feedback_comment'),
  createdAt: ms('created_at').notNull(),
  updatedAt: ms('updated_at').notNull(),
}, (t) => ({
  pk: primaryKey({ columns: [t.eventId, t.email] }),
  emailIdx: index('idx_guest_unsubscribes_email').on(t.email),
}));
