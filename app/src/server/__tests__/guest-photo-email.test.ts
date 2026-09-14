// What the "email me my photos" message tells a guest. Getting the count wrong is not cosmetic: a
// guest told they took five photos who then opens a gallery with two believes we lost three.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { guestSeesPhoto } from '../routes/participants';

describe('the photos a guest is told they took', () => {
  test('with moderation on, only what a host has approved counts', () => {
    assert.equal(guestSeesPhoto('approved', true), true);
    assert.equal(guestSeesPhoto('pending', true), false);
    assert.equal(guestSeesPhoto('rejected', true), false);
  });

  test('with moderation off, anything not binned counts', () => {
    // Pending is a live photo when nobody is moderating — the gallery shows it, so the count must.
    assert.equal(guestSeesPhoto('approved', false), true);
    assert.equal(guestSeesPhoto('pending', false), true);
    assert.equal(guestSeesPhoto('rejected', false), false);
  });

  test('a rejected photo never counts, either way round', () => {
    // The whole bug: five shots, three binned, an email claiming five and a gallery showing two.
    const statuses = ['approved', 'approved', 'rejected', 'rejected', 'rejected'];
    assert.equal(statuses.filter((s) => guestSeesPhoto(s, false)).length, 2);
    assert.equal(statuses.filter((s) => guestSeesPhoto(s, true)).length, 2);
  });
});
