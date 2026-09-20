import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { supportSubject } from '../routes/contact';

/* The subject line of every message that reaches the operator's inbox.
 *
 * It used to be `Snapdini ${label} — ${name || 'someone'}`, which put the literal word "someone" in
 * the subject of every anonymous report. It also never named the event, so the first question about
 * any report — which event is this about? — could only be answered by opening the mail.
 */
describe('supportSubject', () => {
  test('names the guest and the event when both are known', () => {
    assert.equal(supportSubject('feedback report', 'Peter', 'ABC123'),
                 'Snapdini feedback report — Peter — ABC123');
  });

  test('an anonymous report is SHORTER, not padded with a placeholder', () => {
    const s = supportSubject('feedback report', '', 'ABC123');
    assert.equal(s, 'Snapdini feedback report — ABC123');
    assert.ok(!/someone/i.test(s), 'the placeholder must not come back');
  });

  test('no event — the marketing contact form — still reads properly', () => {
    assert.equal(supportSubject('contact message', 'Peter', ''), 'Snapdini contact message — Peter');
  });

  test('neither: just the kind, with no dangling separator', () => {
    const s = supportSubject('contact message', '', '');
    assert.equal(s, 'Snapdini contact message');
    assert.ok(!s.includes('—'), 'a separator with nothing after it is worse than no separator');
  });

  test('null and undefined behave like absent, not like the string "null"', () => {
    // These arrive from the database and from an absent form field respectively.
    assert.equal(supportSubject('bug report', null, undefined), 'Snapdini bug report');
    assert.equal(supportSubject('bug report', undefined, 'XYZ789'), 'Snapdini bug report — XYZ789');
  });

  test('the refund kind reads as a sentence, since that is the one that gets opened first', () => {
    assert.equal(supportSubject('refund / cancellation request', 'Sarah', 'HEN2026'),
                 'Snapdini refund / cancellation request — Sarah — HEN2026');
  });
});
