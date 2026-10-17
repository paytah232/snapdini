import { v5 as uuidv5 } from 'uuid';

/** Same namespace for upload receipts and evidence reconciliation; callers validate raw IDs. */
export function canonicalCapturePhotoId(raw: string, participant: { eventId: string; id: string }): string {
  return uuidv5(JSON.stringify([participant.eventId, participant.id, raw]), '16e1aee4-177e-4f3e-a313-9cb15ecda68a');
}
