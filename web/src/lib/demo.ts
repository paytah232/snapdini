// Where a demo visitor can go from wherever they are.
//
// The demo is a tour of three surfaces — the camera, the host's view, the event gallery — and the
// only thing tying them together is a link row. The camera had one and the gallery did not, so
// tapping through to the gallery was a one-way door: no way to the host view, no way out except the
// browser's back button.
//
// The LOGIC is shared here rather than the markup. The camera's row sits on a dark viewfinder
// overlay and the gallery's sits in a normal page nav, so they render differently on purpose; what
// must not differ is where the links point and how the organizer code is found.
//
// That code is put in localStorage by the landing page when it creates the demo (see +page.svelte).
// It is a bearer credential, but a demo is a throwaway 3-hour event with a 2-guest cap, which is
// exactly why the demo route hands it back at all.
export type DemoLinks = { camera: string; gallery: string; host: string };

export function demoLinks(joinCode: string | null | undefined, organizerCode?: string | null): DemoLinks {
  const code = joinCode || '';
  // The event payload is the reliable source: localStorage only ever had this on the device that
  // STARTED the demo, and the common path is starting it on a laptop and scanning the QR with a
  // phone that has never seen it. Storage stays as a fallback for a cached older response.
  let org = organizerCode || '';
  try { if (!org) org = (typeof localStorage !== 'undefined' && localStorage.getItem('demo_org_' + code)) || ''; }
  catch { org = ''; }   // private mode, or storage blocked — the host link simply is not offered
  return {
    camera: `/join/${code}`,
    gallery: `/gallery/${code}`,
    // Empty when we have no code: a link to the manager that lands on a password prompt is worse
    // than no link, because it reads as the demo being broken.
    host: org ? `/admin/${code}#${encodeURIComponent(org)}` : '',
  };
}
