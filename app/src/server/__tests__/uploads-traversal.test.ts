// The theme header image is the only place a user-supplied string reaches the filesystem as a
// PATH rather than as a name we generated. It was reachable with NO account at all: POST
// /api/events/demo hands an anonymous caller an organizerCode, PUT /events/:code/theme stored the
// string, the slideshow renderer fed it to sharp (arbitrary read) and event deletion unlinked it
// (arbitrary delete). path.join does not neutralise "..", it resolves it.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import { uploadDiskPath, insideUploads, UPLOADS_DIR } from '../paths';

const TRAVERSALS = [
  '/uploads/../../etc/passwd',
  '/uploads/../../../etc/shadow',
  '/uploads/a/../../../etc/passwd',
  '/uploads/./../../etc/passwd',
  '/uploads/..',
  '/uploads/../',
];

describe('uploads path containment', () => {
  for (const p of TRAVERSALS) {
    test(`refuses to map ${p} outside UPLOADS_DIR`, () => {
      assert.throws(() => uploadDiskPath(p), /unsafe uploads path/);
    });
  }

  test('still maps ordinary event assets', () => {
    const rel = 'ab12cd34/9f8e7d6c.jpg';
    assert.equal(uploadDiskPath('/uploads/' + rel), path.join(UPLOADS_DIR, rel));
  });

  test('maps a theme path with dots in the filename', () => {
    assert.equal(uploadDiskPath('/uploads/themes/header.v2.webp'),
                 path.join(UPLOADS_DIR, 'themes/header.v2.webp'));
  });

  test('insideUploads rejects a sibling dir that merely shares the prefix', () => {
    assert.equal(insideUploads(UPLOADS_DIR + '-backup/x.jpg'), false);
    assert.equal(insideUploads(path.join(UPLOADS_DIR, 'x.jpg')), true);
  });
});

describe('UPLOADS_PATH_RE — the gate on what gets stored', () => {
  // Read the real pattern out of the route rather than copying it, so this cannot drift.
  const src = fs.readFileSync(path.join(__dirname, '../routes/events.ts'), 'utf8');
  const m = src.match(/const UPLOADS_PATH_RE = (\/.*\/);/);
  const RE = new RegExp(m![1].slice(1, -1));

  test('the pattern was found in the route', () => assert.ok(m, 'UPLOADS_PATH_RE not found'));
  for (const p of TRAVERSALS) {
    test(`rejects ${p}`, () => assert.equal(RE.test(p), false));
  }
  test('accepts real upload paths', () => {
    assert.equal(RE.test('/uploads/ab12cd34/9f8e7d6c.jpg'), true);
    assert.equal(RE.test('/uploads/themes/header.v2.webp'), true);
  });
});
