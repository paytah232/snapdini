// Snapdini integration spec — 'Sharing / downloads / rating', 'Share v2: filter-aware + manageable + custom URLs'.
import { api, createEvent, dbq, gallery, group, join, ok, org, spec, upload } from '../lib/harness.mjs';

await spec('07-sharing-rating', async () => {
  // ── Sharing: downloads + highlights + rating modes ──
  group('Sharing / downloads / rating');
  const eShare = await createEvent({ revealMode: 'instant', allowDownloads: true });
  const js = await join(eShare.joinCode, 'S'); await upload(js.json.sessionToken);
  ok('gallery allowDownloads=true', (await gallery(eShare.joinCode)).json?.allowDownloads === true);
  ok('zip download 200 when allowed', (await api('GET', `/api/photos/${eShare.joinCode}/download`)).status === 200);
  await api('POST', `/api/events/${eShare.joinCode}/allow-downloads`, { headers: org(eShare.organizerCode), body: { allowDownloads: false } });
  ok('DB allow_downloads=false', dbq(`SELECT allow_downloads FROM events WHERE id='${eShare.id}'`) === 'f');
  ok('zip download 403 when disabled', (await api('GET', `/api/photos/${eShare.joinCode}/download`)).status === 403);
  // rating (favourite mode): 5★ = highlight
  const sp = dbq(`SELECT id FROM photos WHERE event_id='${eShare.id}'`);
  await api('POST', `/api/events/${eShare.joinCode}/rate`, { headers: org(eShare.organizerCode), body: { photoId: sp, rating: 5 } });
  ok('rate 5 → rating=5', dbq(`SELECT rating FROM photos WHERE id='${sp}'`) === '5');
  ok('rate 5 → is_highlighted synced', dbq(`SELECT is_highlighted FROM photos WHERE id='${sp}'`) === 't');
  const gh = await gallery(eShare.joinCode, '&highlightsOnly=true');
  ok('gallery hasHighlights + highlightsOnly filter', gh.json?.hasHighlights === true && gh.json?.photos?.length === 1);
  // stars mode (set via the settings editor — ratingMode is a post-create curation setting): 3★ not a highlight
  const eStars = await createEvent();
  await api('PUT', `/api/events/${eStars.joinCode}/settings`, { headers: org(eStars.organizerCode), body: { ratingMode: 'stars' } });
  ok('DB rating_mode=stars (via settings)', dbq(`SELECT rating_mode FROM events WHERE id='${eStars.id}'`) === 'stars');
  const jst = await join(eStars.joinCode, 'St'); await upload(jst.json.sessionToken);
  const stp = dbq(`SELECT id FROM photos WHERE event_id='${eStars.id}'`);
  await api('POST', `/api/events/${eStars.joinCode}/rate`, { headers: org(eStars.organizerCode), body: { photoId: stp, rating: 3 } });
  ok('rate 3 → rating=3', dbq(`SELECT rating FROM photos WHERE id='${stp}'`) === '3');
  ok('rate 3 → not highlighted (only 5★ is)', dbq(`SELECT is_highlighted FROM photos WHERE id='${stp}'`) === 'f');

  group('Share v2: filter-aware + manageable + custom URLs');
  const eShv = await createEvent({ revealMode: 'instant' });
  const jShv = await join(eShv.joinCode, 'Sh');
  await upload(jShv.json.sessionToken); await upload(jShv.json.sessionToken);
  const shvPhotos = (await api('GET', `/api/photos/${eShv.joinCode}`, { headers: org(eShv.organizerCode) })).json.photos;
  await api('POST', `/api/events/${eShv.joinCode}/rate`, { headers: org(eShv.organizerCode), body: { photoId: shvPhotos[0].id, rating: 5 } });
  const favShare = await api('POST', `/api/events/${eShv.joinCode}/shares`, { headers: org(eShv.organizerCode), body: { kind: 'favourites' } });
  // No pretty slug is claimed by default — the link uses the unique token (/s/<token>).
  ok('create favourites share → token url, no default slug', favShare.status === 200 && favShare.json.slug === null && String(favShare.json.url).includes(`/s/${favShare.json.token}`));
  ok('default share label leads with the event name', /— favourites$/.test(favShare.json.label) && favShare.json.label.length > '— favourites'.length + 1);
  ok('favourites share shows ONLY favourites', (await api('GET', `/api/shares/${favShare.json.token}`)).json?.photos?.length === 1);
  const allShare = await api('POST', `/api/events/${eShv.joinCode}/shares`, { headers: org(eShv.organizerCode), body: { kind: 'all' } });
  ok('view a share by its token', (await api('GET', `/api/shares/${allShare.json.token}`)).json?.photos?.length === 2);
  // Smart links: re-sharing the SAME content reuses the existing link instead of minting a new one.
  ok('re-sharing the whole gallery reuses the link', (await api('POST', `/api/events/${eShv.joinCode}/shares`, { headers: org(eShv.organizerCode), body: { kind: 'all' } })).json?.token === allShare.json.token);
  const sel1 = await api('POST', `/api/events/${eShv.joinCode}/shares`, { headers: org(eShv.organizerCode), body: { kind: 'selected', photoIds: [shvPhotos[0].id, shvPhotos[1].id] } });
  const sel2 = await api('POST', `/api/events/${eShv.joinCode}/shares`, { headers: org(eShv.organizerCode), body: { kind: 'selected', photoIds: [shvPhotos[1].id, shvPhotos[0].id] } });
  ok('re-sharing the same selection (any order) reuses the link', !!sel1.json?.token && sel1.json.token === sel2.json.token);
  ok('owner lists their shares', ((await api('GET', `/api/events/${eShv.joinCode}/shares`, { headers: org(eShv.organizerCode) })).json?.shares?.length ?? 0) >= 2);
  const ren = await api('PATCH', `/api/events/${eShv.joinCode}/shares/${allShare.json.token}`, { headers: org(eShv.organizerCode), body: { label: 'Everything', slug: 'my-custom-link' } });
  ok('rename + custom URL', ren.status === 200 && ren.json.slug === 'my-custom-link');
  ok('view by the NEW custom URL', (await api('GET', `/api/shares/my-custom-link`)).json?.photos?.length === 2);
  ok('duplicate custom URL → 409', (await api('PATCH', `/api/events/${eShv.joinCode}/shares/${favShare.json.token}`, { headers: org(eShv.organizerCode), body: { slug: 'my-custom-link' } })).status === 409);
  await api('DELETE', `/api/events/${eShv.joinCode}/shares/${allShare.json.token}`, { headers: org(eShv.organizerCode) });
  ok('deleted share 404s', (await api('GET', `/api/shares/my-custom-link`)).status === 404);
}, {});
