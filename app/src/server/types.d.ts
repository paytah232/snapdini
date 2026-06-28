// Ambient declarations for the backend.
import type { User, Event, Participant } from './schema';

declare global {
  namespace Express {
    interface Request {
      // Set by auth/organizer/participant middleware in the route files.
      user?: User | null;
      event?: Event;
      participant?: Participant;
    }
  }
}

// express-async-errors is a side-effect-only import with no bundled types.
declare module 'express-async-errors';

export {};
