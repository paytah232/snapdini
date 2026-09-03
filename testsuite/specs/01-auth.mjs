// Snapdini integration spec — 'Auth + account'.
//
// The register -> verify -> /api/auth/me sequence. bootstrapOwner() does this work in every
// spec; only here does it emit its assertions, so the run counts them exactly once.
import { spec } from '../lib/harness.mjs';

await spec('01-auth', async () => {

}, { bootstrap: 'assert' });
