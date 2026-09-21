// Ambient declarations for the backend.
import type { User, Event, Participant } from './schema';

declare global {
  namespace Express {
    interface Request {
      // Set by auth/organizer/participant middleware in the route files.
      user?: User | null;
      event?: Event;
      /** WHICH of requireOrganizer's three doors this request came through.
       *
       *  'owner' and 'cohost' are an IDENTITY — a verified account that can be suspended, billed
       *  or talked to. 'code' is a CAPABILITY: a 32-char string that travels in links, screenshots
       *  and group chats, and that the demo endpoint hands to any stranger who asks for one.
       *
       *  Almost every organizer action is fine on a capability; the one that is not is putting mail
       *  in other people's inboxes from our sending domain, which is why routes/guests.ts reads
       *  this before it sends. Set on every requireOrganizer request so nothing has to re-derive
       *  it, and so a future sender cannot forget that the distinction exists. */
      organizerVia?: 'owner' | 'cohost' | 'code';
      participant?: Participant;
    }
  }
}

export {};
