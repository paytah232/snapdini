// The monthly email allowance. Mailgun's free plan is 3000 messages per calendar month and running
// out is silent — sends start being refused, invites stop arriving, and nothing on any screen says
// why. These tests cover the two things that make the number worth trusting: where the month
// begins and ends, and when it starts shouting.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { monthWindow, budgetLevel, describeUsage, monthlyLimit, warnPercent,
         eventInviteCap, INVITE_FLOOR, INVITE_PASSES, ACCOUNT_DAILY_RECIPIENTS,
         type MonthUsage } from '../email-budget';

// ── The month boundary ───────────────────────────────────────────────────────
// UTC, on purpose: the allowance resets on Mailgun's clock, and counting a Brisbane month would put
// our number and theirs in disagreement by up to ten hours at each boundary — exactly when the
// number matters most and a disagreement is hardest to explain.

describe('which month a send belongs to', () => {
  const JAN = Date.UTC(2026, 0, 1);
  const FEB = Date.UTC(2026, 1, 1);

  test('a send on the 1st, at the very first instant, is in that month', () => {
    const w = monthWindow(JAN);
    assert.equal(w.from, JAN);
    assert.ok(JAN >= w.from && JAN < w.to, 'the 1st fell outside its own month');
    assert.equal(w.label, '2026-01');
  });

  test('a send on the 31st, at the last instant, is still in that month', () => {
    const last = Date.UTC(2026, 0, 31, 23, 59, 59, 999);
    const w = monthWindow(last);
    assert.equal(w.from, JAN);
    assert.ok(last >= w.from && last < w.to, 'the 31st fell outside its own month');
  });

  test('the 31st and the 1st that follows it are in DIFFERENT months', () => {
    // The whole point. A range that counted both would carry January's last send into February and
    // report a month that never runs out on paper while the real one does.
    const last = Date.UTC(2026, 0, 31, 23, 59, 59, 999);
    assert.notEqual(monthWindow(last).from, monthWindow(FEB).from);
    assert.equal(monthWindow(last).to, FEB);
    assert.equal(monthWindow(FEB).from, FEB);
  });

  test('the window is half-open, so a midnight send is counted exactly once', () => {
    // An inclusive upper bound would put the stroke of midnight in both months.
    const jan = monthWindow(JAN);
    assert.equal(jan.to, FEB);
    assert.ok(!(FEB >= jan.from && FEB < jan.to), 'February 1st counted as January');
  });

  test('December rolls the year over without a special case', () => {
    const w = monthWindow(Date.UTC(2026, 11, 20));
    assert.equal(w.from, Date.UTC(2026, 11, 1));
    assert.equal(w.to, Date.UTC(2027, 0, 1));
    assert.equal(w.label, '2026-12');
  });

  test('a short month ends where it ends', () => {
    const w = monthWindow(Date.UTC(2026, 1, 28, 12));
    assert.equal(w.to, Date.UTC(2026, 2, 1));
  });

  test('the label is sortable and zero-padded', () => {
    assert.equal(monthWindow(Date.UTC(2026, 8, 14)).label, '2026-09');
  });
});

// ── The limit ────────────────────────────────────────────────────────────────

describe('the allowance itself', () => {
  test('the free plan is the default', () => {
    delete process.env.MAILGUN_MONTHLY_LIMIT;
    assert.equal(monthlyLimit(), 3000);
  });

  test('a paid plan can say so, because hardcoding 3000 would then be a lie', () => {
    process.env.MAILGUN_MONTHLY_LIMIT = '50000';
    assert.equal(monthlyLimit(), 50000);
    delete process.env.MAILGUN_MONTHLY_LIMIT;
  });

  test('junk falls back rather than reporting an allowance of NaN', () => {
    for (const junk of ['', 'lots', '-5', '0']) {
      process.env.MAILGUN_MONTHLY_LIMIT = junk;
      assert.equal(monthlyLimit(), 3000, `accepted ${JSON.stringify(junk)}`);
    }
    delete process.env.MAILGUN_MONTHLY_LIMIT;
  });

  test('the warning threshold leaves real headroom by default', () => {
    // The derived count is a FLOOR — account and lifecycle mail is not recorded per recipient — so
    // a threshold at 95% would fire with less room than the untracked tail could fill.
    delete process.env.MAILGUN_BUDGET_WARN_PCT;
    assert.equal(warnPercent(), 80);
  });
});

// ── When it shouts ───────────────────────────────────────────────────────────

describe('how close is too close', () => {
  test('an ordinary month says nothing', () => {
    assert.equal(budgetLevel(400, 3000, 80), 'ok');
  });

  test('the threshold is inclusive — exactly 80% already warns', () => {
    assert.equal(budgetLevel(2400, 3000, 80), 'warn');
    assert.equal(budgetLevel(2399, 3000, 80), 'ok');
  });

  test('reaching the limit is over, not merely warned', () => {
    assert.equal(budgetLevel(3000, 3000, 80), 'over');
    assert.equal(budgetLevel(3001, 3000, 80), 'over');
  });

  test('no limit configured is not an emergency', () => {
    // budgetLevel is the only thing standing between a misconfigured limit and a daily 🛑 digest.
    assert.equal(budgetLevel(9999, 0, 80), 'ok');
  });
});

// ── The caps that are ENFORCED ───────────────────────────────────────────────
// The numbers above are a report. These two are the bound on what somebody who has taken a host's
// account can do with our sending domain before anyone notices, so what matters about them is that
// they cannot be tripped by a real host and cannot be escaped by a determined one.

describe('the lifetime invite cap for one event', () => {
  test('a host may mail their whole list three times over', () => {
    // Send the invitations, re-send to whoever did not open them, mail the late additions. Three
    // passes is already generous; the test is here so nobody quietly makes it one.
    assert.equal(INVITE_PASSES, 3);
    assert.equal(eventInviteCap(200), 600);
    assert.equal(eventInviteCap(2000), 6000, 'the biggest list the product allows must still get three passes');
  });

  test('and a small list is governed by the floor, not by a tiny multiple', () => {
    // 3 x 4 guests = 12 is a number a real host with a small dinner could hit by fiddling.
    assert.equal(eventInviteCap(4), INVITE_FLOOR);
    assert.equal(eventInviteCap(0), INVITE_FLOOR, 'an empty list must not produce a cap of zero');
    assert.ok(INVITE_FLOOR >= 100, 'the floor is low enough for a real host to notice');
  });

  test('the cap grows as the guest list does, so adding people never locks a host out', () => {
    // Measured against the CURRENT size: invite 40, add 60 more, invite again — nowhere near it.
    assert.ok(eventInviteCap(100) > eventInviteCap(40));
    assert.equal(eventInviteCap(40) < 40 * 2, false, 'two full passes must fit under the cap');
  });
});

describe('the daily cap for one account', () => {
  test('it sits above the biggest real day and below the monthly allowance', () => {
    // Above: the largest list the product allows is 2000 (MAX_GUESTS_PER_EVENT), invited once.
    assert.ok(ACCOUNT_DAILY_RECIPIENTS >= 2000, 'a host with the biggest allowed list could not invite them');
    // Below: 3000 is Mailgun's whole free month. A day that spends more than this is a number an
    // operator should have agreed to rather than discovered.
    assert.ok(ACCOUNT_DAILY_RECIPIENTS < monthlyLimit(), 'one account can spend a whole month in a day');
  });
});

describe('what the operator is told', () => {
  const usage = (total: number, level: MonthUsage['level']): MonthUsage => ({
    month: '2026-09', invites: total, shares: 0, total, limit: 3000,
    remaining: Math.max(0, 3000 - total), percent: Math.round((total / 3000) * 100), level,
  });

  test('a quiet month reports the number and what is left', () => {
    const s = describeUsage(usage(300, 'ok'));
    assert.ok(s.includes('300 of 3000'));
    assert.ok(s.includes('2700 left'));
  });

  test('a warning says how much room is left and that the plan is the lever', () => {
    const s = describeUsage(usage(2500, 'warn'));
    assert.ok(s.includes('500 left'));
    assert.ok(/plan/i.test(s));
  });

  test('past the limit it says sends are NOT being blocked', () => {
    // Deliberate, and the operator has to know it: silently refusing a host's invites would be a
    // worse outcome than an overage, so the limit is reported and never enforced.
    const s = describeUsage(usage(3200, 'over'));
    assert.ok(/not being blocked/i.test(s), s);
  });
});
