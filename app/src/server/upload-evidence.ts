import { randomUUID } from 'node:crypto';
import type { Request, RequestHandler, ErrorRequestHandler } from 'express';
import { rateLimit } from 'express-rate-limit';
import { and, desc, eq, inArray } from 'drizzle-orm';
import { db } from './db';
import { canonicalCapturePhotoId } from './capture-photo-id';
import { captureEvidence, participants, photos } from './schema';
export const CLIENT_STAGES = ['local_saved', 'upload_started', 'upload_failed', 'server_acknowledged', 'local_removed'] as const;
export const CLIENT_REASONS = ['network', 'timeout', 'http_error', 'storage_error', 'storage_unavailable', 'user_removed', 'uploaded', 'unknown'] as const;
export const safeCaptureId = (v: unknown): v is string => typeof v === 'string' && /^[A-Za-z0-9_-]{8,128}$/.test(v);
const safeUploadId = (v: unknown): v is string => typeof v === 'string' && /^[A-Za-z0-9_-]{8,64}$/.test(v);
const bounded = (v: unknown, max: number) => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 && v <= max;
export type ClientEvidence = {
  id: string;
  captureId: string;
  stage: typeof CLIENT_STAGES[number];
  at: number;
  uploadId?: string;
  chunkIndex?: number;
  chunkTotal?: number;
  bytes?: number;
  httpStatus?: number;
  reason?: string;
  photoId?: string;
};
export function parseClientEvidence(value: unknown): ClientEvidence[] | null {
  if (!Array.isArray(value) || value.length < 1 || value.length > 50)
    return null;
  const rows: ClientEvidence[] = [];
  for (const raw of value) {
    if (!raw || typeof raw !== 'object')
      return null;
    const r = raw as Record<string, unknown>;
    if (typeof r.id !== 'string' || !/^[A-Za-z0-9_:-]{8,160}$/.test(r.id) || !safeCaptureId(r.captureId) || !CLIENT_STAGES.includes(r.stage as never) || !bounded(r.at, 8640000000000000))
      return null;
    if (r.uploadId !== undefined && !safeUploadId(r.uploadId))
      return null;
    for (const [key, max] of [['chunkIndex', 10000], ['chunkTotal', 10000], ['bytes', 16 * 1024 ** 3], ['httpStatus', 599]] as const)
      if (r[key] !== undefined && !bounded(r[key], max))
        return null;
    if (r.reason !== undefined && !(CLIENT_REASONS.includes(r.reason as never) || typeof r.reason === 'string' && /^http_[1-5][0-9]{2}$/.test(r.reason)))
      return null;
    if (r.photoId !== undefined && (typeof r.photoId !== 'string' || !/^[a-fA-F0-9-]{36}$/.test(r.photoId)))
      return null;
    rows.push(Object.fromEntries(['id', 'captureId', 'stage', 'at', 'uploadId', 'chunkIndex', 'chunkTotal', 'bytes', 'httpStatus', 'reason', 'photoId'].filter(k => r[k] !== undefined).map(k => [k, r[k]])) as ClientEvidence);
  }
  return rows;
}
const actorFor = async (token: unknown) => {
  if (typeof token !== 'string' || token.length < 8 || token.length > 256)
    return null;
  const [actor] = await db.select({ id: participants.id, eventId: participants.eventId }).from(participants).where(eq(participants.sessionToken, token));
  return actor ?? null;
};
type EvidenceActor = {
  id: string;
  eventId: string;
};
const authenticatedActors = new WeakMap<Request, EvidenceActor>();
export const requireEvidenceParticipant: RequestHandler = async (req, res, next) => {
  const actor = await actorFor(req.get('x-session-token'));
  if (!actor) {
    res.status(403).json({ error: 'Invalid session' });
    return;
  }
  authenticatedActors.set(req, actor);
  next();
};
export function evidenceParticipantKey(req: Request): string {
  const actor = authenticatedActors.get(req);
  if (!actor)
    throw new Error('Evidence limiter requires authenticated participant');
  return actor.id;
}
export const evidenceLimiter = rateLimit({
  windowMs: 60000, limit: 30, standardHeaders: 'draft-8', legacyHeaders: false,
  keyGenerator: evidenceParticipantKey,
  message: { error: 'Too many evidence requests' },
});
export const acceptClientEvidence: RequestHandler = async (req, res) => {
  res.set('Cache-Control', 'no-store');
  const actor = authenticatedActors.get(req) ?? await actorFor(req.get('x-session-token'));
  if (!actor) {
    res.status(403).json({ error: 'Invalid session' });
    return;
  }
  const rows = parseClientEvidence(req.body?.events);
  if (!rows) {
    res.status(400).json({ error: 'Invalid evidence batch' });
    return;
  }
  const now = Date.now();
  // Fixed cap per roll also bounds authenticated identifier churn. Client keeps unaccepted rows.
  const recent = await db.select({ evidenceId: captureEvidence.evidenceId }).from(captureEvidence).where(and(eq(captureEvidence.participantId, actor.id), eq(captureEvidence.source, 'client'))).limit(5001);
  const known = new Set(recent.map(r => r.evidenceId));
  const novel = new Set(rows.filter(row => !known.has(row.id)).map(row => row.id));
  if (recent.length + novel.size > 5000) {
    res.status(429).json({ error: 'Evidence limit reached' });
    return;
  }
  await db.insert(captureEvidence).values(rows.map(row => ({
    ...row, evidenceId: row.id, id: randomUUID(), eventId: actor.eventId, participantId: actor.id, source: 'client', receivedAt: now
  }))).onConflictDoNothing();
  res.json({ accepted: rows.map(row => row.id) });
};
export function rejectionReason(message: unknown): string {
  const text = typeof message === 'string' ? message : '';
  const exact: Record<string, string> = {
    'Bad chunk request': 'bad_chunk_request', 'Bad complete request': 'bad_complete_request', 'Invalid captureId': 'invalid_capture_id', 'No file uploaded': 'no_file', 'No chunk uploaded': 'no_file', 'Invalid session': 'invalid_session', 'Could not store chunk': 'chunk_store_failed', 'Missing chunks': 'missing_chunks', 'Reassembly failed': 'reassembly_failed', 'Video uploads are not enabled for this event': 'video_disabled', "Event hasn't started yet": 'not_started', 'Event is locked': 'event_locked', 'Event has ended': 'event_ended', 'Event photos have been deleted': 'media_deleted', 'No shots remaining': 'quota_exhausted', 'Upload failed': 'processing_failed', 'Only photos and videos can be uploaded': 'unsupported_media'
  };
  return exact[text] ?? (/too large/i.test(text) ? 'file_too_large' : 'other_rejection');
}
const replayedReceipts = new WeakSet<object>();
export function replayedReceipt<T extends object>(receipt: T): T { replayedReceipts.add(receipt); return receipt; }
const parserReasons = new WeakMap<Request, string>();
export function uploadRejection(req: Request, reason: string): void { parserReasons.set(req, reason); }
export const observeUploadParserError: ErrorRequestHandler = (err, req, _res, next) => {
  const codes: Record<string, string> = {
    LIMIT_FILE_SIZE: 'file_too_large', LIMIT_UNEXPECTED_FILE: 'unexpected_file', LIMIT_FIELD_COUNT: 'too_many_fields', LIMIT_FIELD_VALUE: 'field_too_large', LIMIT_PART_COUNT: 'too_many_parts', LIMIT_FILE_COUNT: 'too_many_files', LIMIT_FIELD_KEY: 'field_name_too_long'
  };
  parserReasons.set(req, codes[err?.code] ?? (err?.message === 'Only photos and videos can be uploaded' ? 'unsupported_media' : 'parser_error'));
  next(err);
};
/** Metadata is best effort: diagnostic failures must never delay or fail a media response. */
export const observeUpload: RequestHandler = (req, res, next) => {
  const at = Date.now();
  const uploadKind = req.path;
  const json = res.json.bind(res);
  res.json = ((body: unknown) => { void recordUpload(req, res.statusCode, body, at, uploadKind, !!body && typeof body === 'object' && replayedReceipts.has(body)).catch(() => console.warn('[upload-evidence] journal unavailable')); return json(body); }) as typeof res.json;
  next();
};
async function recordUpload(req: Request, status: number, body: unknown, at: number, uploadKind: string, replayed: boolean) {
  // When both are present, evidence follows the exact identity the handler used.
  if (req.body?.sessionToken && req.get('x-session-token') && req.body.sessionToken !== req.get('x-session-token'))
    return;
  const actor = await actorFor(req.body?.sessionToken || req.get('x-session-token'));
  const captureId = req.body?.captureId ?? req.get('x-capture-id');
  if (!actor || !safeCaptureId(captureId))
    return;
  const uploadId = req.body?.uploadId ?? req.get('x-upload-id');
  const output = body as {
    error?: unknown;
    photoId?: unknown;
  } | null;
  const photoId = typeof output?.photoId === 'string' ? output.photoId : undefined;
  const success = status >= 200 && status < 300;
  const num = (header: string, field: string, max: number) => { const raw = req.body?.[field] ?? req.get(header); const n = typeof raw === 'string' ? parseInt(raw, 10) : raw; return bounded(n, max) ? n : null; };
  const id = randomUUID();
  const base = {
    eventId: actor.eventId, participantId: actor.id, captureId, uploadId: safeUploadId(uploadId) ? uploadId : null, source: 'server', receivedAt: Date.now(), httpStatus: status, chunkIndex: num('x-upload-index', 'index', 10000), chunkTotal: num('x-upload-total', 'total', 10000), bytes: req.file?.size ?? null
  };
  const rows = [{
      ...base, id: randomUUID(), evidenceId: `${id}:received`, stage: 'received', at, reason: null as string | null, photoId: null as string | null
    }];
  if (success && photoId) {
    const [stored] = await db.select({ id: photos.id }).from(photos).where(and(eq(photos.id, photoId), eq(photos.participantId, actor.id), eq(photos.eventId, actor.eventId)));
    rows.push({
      ...rows[0], id: randomUUID(), evidenceId: `${id}:result`, stage: stored ? (replayed ? 'server_replayed' : 'server_stored') : 'response_sent', at: Date.now(), photoId: stored?.id ?? null
    });
  }
  else
    rows.push({
      ...rows[0], id: randomUUID(), evidenceId: `${id}:result`, stage: success && uploadKind === '/chunk' ? 'chunk_accepted' : success ? 'response_sent' : uploadKind === '/chunk' ? 'chunk_rejected' : 'upload_rejected', at: Date.now(), reason: success ? null : parserReasons.get(req) ?? rejectionReason(output?.error)
    });
  await db.insert(captureEvidence).values(rows).onConflictDoNothing();
}
export async function evidenceForEvent(eventId: string, limit: number) {
  const rows = await db.select().from(captureEvidence).where(eq(captureEvidence.eventId, eventId)).orderBy(desc(captureEvidence.receivedAt), desc(captureEvidence.id)).limit(limit + 1);
  const truncated = rows.length > limit;
  rows.length = Math.min(rows.length, limit);
  const groups = new Map<string, {
    participantId: string;
    captureId: string;
    storedPhotoIds: string[];
    clientAcknowledged: boolean;
    stages: typeof rows;
  }>();
  for (const row of rows) {
    const key = JSON.stringify([row.participantId, row.captureId]);
    let group = groups.get(key);
    if (!group) {
      group = {
        participantId: row.participantId, captureId: row.captureId, storedPhotoIds: [], clientAcknowledged: false, stages: []
      };
      groups.set(key, group);
    }
    if (row.source === 'client' && row.stage === 'server_acknowledged')
      group.clientAcknowledged = true;
    group.stages.push(row);
  }
  // The photo table is authoritative even if the asynchronous server journal write failed.
  // Never derive storage proof from a client-provided photoId.
  const expected = new Map([...groups.values()].map(group => [
    canonicalCapturePhotoId(group.captureId, { eventId, id: group.participantId }), group,
  ]));
  const ids = [...expected.keys()];
  const stored = ids.length ? await db.select({ id: photos.id, participantId: photos.participantId })
    .from(photos).where(and(eq(photos.eventId, eventId), inArray(photos.id, ids))) : [];
  for (const row of stored) {
    const group = expected.get(row.id);
    if (group && group.participantId === row.participantId)
      group.storedPhotoIds.push(row.id);
  }
  return {
    captures: [...groups.values()], truncated, retentionDays: 30, clientClaimsAreUnverified: true
  };
}
