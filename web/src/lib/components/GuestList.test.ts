// Two things about this card that are easy to break and were both broken at once.
//
// 1. The INFORMATION SPLIT. A guest row answers two different questions and they do not belong on
//    screen together: "who is coming and did their invite land?" is asked of the whole list at a
//    glance, and "what do I do about this one?" is asked of exactly one row at a time. The first
//    lives in the <summary>, the second inside the row. Asserting on the <summary>'s own text is
//    the point — the body is in the DOM either way, so "is it in the document" proves nothing.
//
// 2. A `disabled` button is not inert, it is DEAD. It consumes no events, so the press falls
//    through to the text behind it and a phone answers with its own Copy/Search menu. The host
//    reported this as "Preview seems to do nothing", which is exactly what it did. Every blocked
//    control here is `aria-disabled` and every one of them answers the press.
import { describe, it, expect, beforeEach } from 'vitest';
import { render, fireEvent } from '@testing-library/svelte';
import { get } from 'svelte/store';
import { tick } from 'svelte';
import GuestList from './GuestList.svelte';
import { toast, hideToast } from '$lib/toast';
import type { GuestListPayload, EventGuest, ImportPreview } from '$lib/events';

const guest = (over: Partial<EventGuest> = {}): EventGuest => ({
  id: 'g1', name: 'Jo Smith', email: 'jo@example.com',
  notes: 'Coming with Dan', createdAt: 0, lastInvite: null, suppressed: null, ...over,
});

const payload = (over: Partial<GuestListPayload> = {}): GuestListPayload => ({
  guests: [guest()], invites: [], emailEnabled: true, deliveryTracking: true, ...over,
});

/** The closed row's own words — everything else in the row is behind the disclosure. */
const summaryText = (c: HTMLElement) =>
  c.querySelector('details.guest-disc > summary')?.textContent ?? '';
const bodyText = (c: HTMLElement) =>
  c.querySelector('details.guest-disc .disc-body')?.textContent ?? '';

beforeEach(() => hideToast());

describe('what a guest row says before you open it', () => {
  it('shows the name and the delivery badge, and nothing else', () => {
    const { container } = render(GuestList, {
      props: { data: payload({ guests: [guest({
        lastInvite: { status: 'delivered', reason: null, provider: 'mailgun', sentAt: 1_700_000_000_000, updatedAt: 0 },
      })] }) },
    });
    const s = summaryText(container);
    expect(s).toContain('Jo Smith');
    expect(s).toContain('Delivered');
    // The ones that made the card a wall at twenty guests.
    expect(s).not.toContain('jo@example.com');
    expect(s).not.toContain('Coming with Dan');
  });

  it('keeps every one of those reachable inside the row', () => {
    const { container } = render(GuestList, {
      props: { data: payload({ guests: [guest({
        lastInvite: { status: 'bounced', reason: '550 no such user', provider: 'mailgun', sentAt: 1_700_000_000_000, updatedAt: 0 },
      })] }) },
    });
    const b = bodyText(container);
    expect(b).toContain('jo@example.com');
    expect(b).toContain('Coming with Dan');
    // The mail server's own words — "550 no such user" means fix the address, "mailbox full" means
    // try tomorrow, and a host who only sees "Bounced" cannot tell which they have.
    expect(b).toContain('550 no such user');
    expect(b).toContain('Resend');
    expect(b).toContain('Edit');
    expect(b).toContain('Remove');
  });

  it('starts closed, so a long list reads as a list', () => {
    const { container } = render(GuestList, { props: { data: payload() } });
    const d = container.querySelector('details.guest-disc') as HTMLDetailsElement;
    expect(d.open).toBe(false);
  });

  it('promotes the address to the row title when that is all the guest has', () => {
    const { container } = render(GuestList, {
      props: { data: payload({ guests: [guest({ name: null, notes: null })] }) },
    });
    expect(summaryText(container)).toContain('jo@example.com');
    // ...and does not then repeat it underneath.
    expect(bodyText(container)).not.toContain('jo@example.com');
  });

  it('keeps Blocked on the closed row — it is why a send will skip them', () => {
    const { container } = render(GuestList, {
      props: { data: payload({ guests: [guest({
        suppressed: { reason: 'hard bounce', detail: '550 mailbox unavailable', since: 0 },
      })] }) },
    });
    expect(summaryText(container)).toContain('Blocked · hard bounce');
    expect(bodyText(container)).toContain('550 mailbox unavailable');
  });
});

describe('the card header', () => {
  it('carries the total and the number needing a decision, not the address breakdown', () => {
    const { container } = render(GuestList, {
      props: { data: payload({ guests: [
        guest({ id: 'a' }),
        guest({ id: 'b', email: 'sam@example.com' }),
        guest({ id: 'c', lastInvite: { status: 'bounced', reason: null, provider: 'mailgun', sentAt: 1, updatedAt: 0 } }),
      ] }) },
    });
    const head = container.querySelector('.counts')!.textContent!;
    expect(head).toContain('3 guests');
    expect(head).toContain('1 needs a look');
    expect(head).not.toContain('with an email');
  });

  it('keeps the invite-list distinction in the disclosure, and drops the address breakdown', () => {
    // CHANGED with the email requirement. "1 of 2 have an email address" was a real number while an
    // address was optional; now every guest has one, so the line could only ever say the total
    // twice. What the disclosure is FOR survives it.
    const { container } = render(GuestList, {
      props: { data: payload({ guests: [guest({ id: 'a' }), guest({ id: 'b', email: 'sam@example.com' })] }) },
    });
    const disc = container.querySelector('details.disc:not(.guest-disc) .disc-body')!.textContent!;
    expect(disc).not.toContain('have an email address');
    // The invite-list/participants distinction — the thing a host gets wrong and finds out too late.
    expect(disc).toContain('Photos go to whoever joins');
  });

  it('keeps the delivery-tracking caveat when the server cannot see', () => {
    const { container } = render(GuestList, { props: { data: payload({ deliveryTracking: false }) } });
    const disc = container.querySelector('details.disc:not(.guest-disc) .disc-body')!.textContent!;
    expect(disc).toContain('delivery unknown');
  });
});

describe('a blocked control answers its press', () => {
  const pressable = (c: HTMLElement, text: string) =>
    [...c.querySelectorAll('button')].find((b) => b.textContent?.trim().startsWith(text))!;

  it('Preview is aria-disabled, never disabled, and says what is missing', async () => {
    const { container } = render(GuestList, { props: { data: payload() } });
    await fireEvent.click(pressable(container, 'Import'));
    await tick();

    const btn = pressable(container, 'Preview');
    // The whole defect: `disabled` swallows the press, so the host sees nothing at all.
    expect(btn.hasAttribute('disabled')).toBe(false);
    expect(btn.getAttribute('aria-disabled')).toBe('true');

    await fireEvent.click(btn);
    // The server's own 400 for an empty body, said without the round trip the host could not reach.
    expect(get(toast)?.msg).toBe('Paste some rows, or choose a file');
  });

  it('Preview asks for the read once there is something to read', async () => {
    const fired: { text: string }[] = [];
    const { container, component } = render(GuestList, {
      props: { data: payload(), importText: 'Name,Email\nJo,jo@example.com' },
    });
    component.$on('preview', (e) => fired.push(e.detail));
    await fireEvent.click(pressable(container, 'Import'));
    await tick();
    await fireEvent.click(pressable(container, 'Preview'));
    expect(fired).toHaveLength(1);
    expect(fired[0].text).toContain('jo@example.com');
  });

  it('Send invites with nobody mailable answers, and opens the panel that fixes it', async () => {
    // The fixture CHANGED: it used to be a guest with `email: null`, which is no longer a guest
    // this product can hold. An empty list is what "nobody to send to" means now.
    const { container } = render(GuestList, {
      props: { data: payload({ guests: [] }) },
    });
    const btn = pressable(container, 'Send invites');
    expect(btn.hasAttribute('disabled')).toBe(false);
    expect(btn.getAttribute('aria-disabled')).toBe('true');

    await fireEvent.click(btn);
    await tick();
    expect(get(toast)?.msg).toContain('email address');
    // Taken to the thing that is blocking them, not just told about it.
    expect(container.querySelector('.panel input[placeholder="Name"]')).not.toBeNull();
  });

  it('Add to list without an email says what is missing, and sends nothing', async () => {
    // The requirement, pinned where the host meets it. A name-only plus-one used to be a perfectly
    // good entry; the list is for emailing join links, so it is not one any more — and the press
    // has to SAY that, in the same words the server would, rather than dying quietly.
    const fired: unknown[] = [];
    const { container, component } = render(GuestList, { props: { data: payload({ guests: [] }) } });
    component.$on('add', (e) => fired.push(e.detail));
    await fireEvent.click(pressable(container, '+ Add guest'));
    await tick();
    const name = container.querySelector('input[placeholder="Name"]') as HTMLInputElement;
    await fireEvent.input(name, { target: { value: 'Dan’s partner' } });

    const btn = pressable(container, 'Add to list');
    expect(btn.hasAttribute('disabled')).toBe(false);
    expect(btn.getAttribute('aria-disabled')).toBe('true');
    await fireEvent.click(btn);

    expect(fired).toHaveLength(0);
    expect(get(toast)?.msg).toContain('Add an email address');
    // And it says what to do about that guest, which is the half a bare "required" leaves out.
    expect(get(toast)?.msg).toContain('Print a card');
    // The panel stays open on the field that is missing rather than closing over the mistake.
    expect(container.querySelector('input[type="email"]')).not.toBeNull();
  });

  it('says so when every address is blocked, rather than blaming an empty list', async () => {
    const { container } = render(GuestList, {
      props: { data: payload({ guests: [guest({
        suppressed: { reason: 'hard bounce', detail: null, since: 0 },
      })] }) },
    });
    await fireEvent.click(pressable(container, 'Send invites'));
    expect(get(toast)?.msg).toContain('blocked from further sends');
  });
});

// ── The import panel, and the three ways it answered the host's question wrongly ──────────────
//
// 1. A FATAL HID THE CONTROL IT ASKED FOR. The mapping fatal (then "map at least one column to Name
//    or Email", now "Map a column to Email") was rendered in the {:else}-less branch, with the
//    column mapper in the {:else}. So the panel told the host to do something and removed the
//    thing — a dead end, and indistinguishable from the Preview button doing nothing, which is
//    exactly how it was reported.
// 2. THE TALLY READ AS A LINE NUMBER. A bold count flush left, directly above monospace line
//    numbers flush left, rendered as "1 to add" / "2  Jo Smith" — so the host read line 1 and
//    line 2 and concluded the header had been imported. The numbering starting at 2 was the proof
//    it had not.
// 3. THE HEADER ROW WAS INVISIBLE. A row that is consumed and not imported should be shown with
//    its reason, like every other skipped row in this panel.
describe('the import preview', () => {
  const press = (c: HTMLElement, text: string) =>
    [...c.querySelectorAll('button')].find((b) => b.textContent?.trim().startsWith(text))!;

  const prev = (over: Partial<ImportPreview> = {}): ImportPreview => ({
    headers: ['Name', 'Email'],
    headerless: false,
    delimiter: ',',
    mapping: ['name', 'email'],
    counts: { add: 1, skip: 0, duplicate: 0, invalid: 0, noEmail: 0 },
    fatal: null,
    rows: [{ line: 2, guest: { name: 'Jo Smith', email: 'jo@example.com', notes: null },
             action: 'add', problems: [] }],
    truncated: false,
    total: 1,
    ...over,
  });

  /** Render with the import panel already open. */
  async function openImport(over: Partial<ImportPreview> | null = null) {
    const r = render(GuestList, {
      props: { data: payload(), importText: 'Name,Email\nJo Smith,jo@example.com',
               preview: over === null ? null : prev(over) },
    });
    await fireEvent.click(press(r.container, 'Import'));
    await tick();
    return r;
  }

  const selects = (c: HTMLElement) => [...c.querySelectorAll('.map select')] as HTMLSelectElement[];

  it('renders the mapper ALONGSIDE a fatal, not instead of it', async () => {
    const { container } = await openImport({
      headerless: true,
      headers: ['Column 1', 'Column 2'],
      mapping: ['ignore', 'ignore'],
      counts: { add: 0, skip: 0, duplicate: 0, invalid: 0, noEmail: 0 },
      rows: [],
      total: 0,
      fatal: 'Map a column to Email — that is how the join link is sent, so every guest needs one.',
    });
    expect(container.querySelector('.hint.bad')?.textContent).toContain('Map a column to Email');
    // The whole defect: the message names a control, so the control has to be on screen.
    expect(selects(container)).toHaveLength(2);
    expect(container.textContent).toContain('Column 1');
    expect(container.textContent).toContain('Column 2');
  });

  it('lets the host act on that mapper, which is the way out of the dead end', async () => {
    const fired: { mapping?: string[] }[] = [];
    const { container, component } = await openImport({
      headers: ['Column 1', 'Column 2'], headerless: true, mapping: ['ignore', 'ignore'],
      counts: { add: 0, skip: 0, duplicate: 0, invalid: 0, noEmail: 0 }, rows: [], total: 0,
      fatal: 'Map a column to Email — that is how the join link is sent, so every guest needs one.',
    });
    component.$on('preview', (e) => fired.push(e.detail));
    const s = selects(container)[1];
    s.value = 'email';
    await fireEvent.change(s);
    expect(fired).toHaveLength(1);
    expect(fired[0].mapping).toEqual(['ignore', 'email']);
  });

  it('answers the Import press when the plan is fatal instead of swallowing it', async () => {
    const { container } = await openImport({
      mapping: ['ignore', 'ignore'], counts: { add: 0, skip: 0, duplicate: 0, invalid: 0, noEmail: 0 },
      rows: [], total: 0, fatal: 'Map a column to Email — that is how the join link is sent, so every guest needs one.',
    });
    const btn = [...container.querySelectorAll('.row-acts button')]
      .find((b) => b.textContent?.trim() === 'Import')!;
    expect(btn.hasAttribute('disabled')).toBe(false);
    expect(btn.getAttribute('aria-disabled')).toBe('true');
    await fireEvent.click(btn);
    expect(get(toast)?.msg).toContain('Map a column to Email');
  });

  it('shows the header row, greyed, with its reason — so the numbering explains itself', async () => {
    const { container } = await openImport({});
    const hdr = container.querySelector('.prow.hdr')!;
    expect(hdr).not.toBeNull();
    expect(hdr.classList.contains('skip')).toBe(true);
    expect(hdr.querySelector('.ln')?.textContent).toBe('1');
    expect(hdr.textContent).toContain('Header row');
    // ...and the guest below it is still line 2, which is the fact the host doubted.
    const rows = [...container.querySelectorAll('.prow')];
    expect(rows[1].querySelector('.ln')?.textContent).toBe('2');
  });

  it('shows no header row when there was no header — line 1 IS a guest there', async () => {
    const { container } = await openImport({
      headerless: true, headers: ['Column 1', 'Column 2'], mapping: ['name', 'email'],
      rows: [{ line: 1, guest: { name: 'Jo Smith', email: 'jo@example.com', notes: null },
               action: 'add', problems: [] }],
    });
    expect(container.querySelector('.prow.hdr')).toBeNull();
    expect(container.querySelector('.prow .ln')?.textContent).toBe('1');
    // The host is still told what happened to their first line.
    expect(container.textContent).toContain('No header row found');
  });

  it('shows a no-email row greyed, with its reason and its own number in the tally', async () => {
    // The half that makes the requirement survivable. A host pasting a spreadsheet where some
    // people have no address must SEE which rows those are and how many — "1 imported" out of two,
    // with nothing else said, is how someone finds out at the party that a guest was never invited.
    const { container } = await openImport({
      counts: { add: 1, skip: 1, duplicate: 0, invalid: 0, noEmail: 1 },
      rows: [
        { line: 2, guest: { name: 'Jo Smith', email: 'jo@example.com', notes: null },
          action: 'add', problems: [] },
        { line: 3, guest: { name: 'Dan’s partner', email: null, notes: null },
          action: 'skip', problems: ['No email address — skipped'] },
      ],
      total: 2,
    });
    const rows = [...container.querySelectorAll('.prow')].filter((r) => !r.classList.contains('hdr'));
    expect(rows).toHaveLength(2);
    expect(rows[1].classList.contains('skip')).toBe(true);
    // Greyed, not hidden — and still carrying the name, so the host knows who to print a card for.
    expect(rows[1].textContent).toContain('Dan’s partner');
    expect(rows[1].textContent).toContain('No email address');
    // Its own count, not folded into "skipped": it is the one skip reason the host can act on.
    expect(container.querySelector('.tally')!.textContent).toContain('1 with no email');
    expect(container.textContent).toContain('print those guests a card');
  });

  it('does not open the tally with a bare numeral in the line-number column', async () => {
    const { container } = await openImport({});
    const tally = container.querySelector('.tally')!.textContent!.trim();
    expect(tally.startsWith('Ready to add')).toBe(true);
    expect(/^\d/.test(tally)).toBe(false);
    expect(tally).toContain('1');
  });

  it('says which formats are accepted, and confirms which one was read', async () => {
    const { container } = await openImport({ delimiter: 'tab' });
    const text = container.textContent!;
    // Up front: what you may paste. Afterwards: what it actually was. Different facts, said once.
    expect(text).toContain('Tabs, commas and semicolons all work');
    expect(text).toContain('Read as tab-separated');
    expect(text).not.toContain('Read as comma-separated');
  });

  it('names the comma and semicolon cases too', async () => {
    const a = await openImport({ delimiter: ',' });
    expect(a.container.textContent).toContain('Read as comma-separated');
    const b = await openImport({ delimiter: ';' });
    expect(b.container.textContent).toContain('Read as semicolon-separated');
  });

  it('sends back the mapping it was shown, so the commit cannot differ from the preview', async () => {
    const fired: { mapping?: string[] }[] = [];
    const { container, component } = await openImport({ mapping: ['name', 'email'] });
    component.$on('import', (e) => fired.push(e.detail));
    await fireEvent.click(press(container, 'Import 1 guest'));
    expect(fired).toHaveLength(1);
    expect(fired[0].mapping).toEqual(['name', 'email']);
  });
});

// The list is alphabetical now (see GUEST_ORDER in routes/guests.ts), which is what a host wants
// when they are hunting for a person — but it means a saved guest lands in the MIDDLE of the list
// rather than on the end, and a rename moves them on purpose. Both read as "nothing happened".
describe('where the guest you just saved went', () => {
  it('rings the row after an edit', async () => {
    const { container } = render(GuestList, { props: { data: payload() } });
    await fireEvent.click([...container.querySelectorAll('button')]
      .find((b) => b.textContent?.trim() === 'Edit')!);
    await tick();
    await fireEvent.click([...container.querySelectorAll('button')]
      .find((b) => b.textContent?.trim() === 'Save')!);
    await tick();
    expect(container.querySelector('details.guest-disc.flash')).not.toBeNull();
  });

  it('rings the row an ADD landed on, once the server says which row that is', async () => {
    // An add has no id until the list comes back, so the row is matched on the way back by what
    // the host typed — the id cannot be known at dispatch time.
    const { container, component } = render(GuestList, { props: { data: payload({ guests: [] }) } });
    await fireEvent.click([...container.querySelectorAll('button')]
      .find((b) => b.textContent?.trim() === '+ Add guest')!);
    await tick();
    const box = container.querySelector('input[placeholder="Name"]') as HTMLInputElement;
    await fireEvent.input(box, { target: { value: 'Jo Smith' } });
    const mail = container.querySelector('input[type="email"]') as HTMLInputElement;
    await fireEvent.input(mail, { target: { value: 'jo@example.com' } });
    await fireEvent.click([...container.querySelectorAll('button')]
      .find((b) => b.textContent?.trim() === 'Add to list')!);
    await tick();
    // Nothing to ring yet — the guest does not exist.
    expect(container.querySelector('details.guest-disc.flash')).toBeNull();
    component.$set({ data: payload() });
    await tick();
    expect(container.querySelector('details.guest-disc.flash')).not.toBeNull();
  });
});

// ── The delivery that is not really a delivery ───────────────────────────────
//
// Mailgun reports a message Gmail quarantined as `delivered`, and the only evidence is a phrase
// inside the receiving server's own reply, which already reaches this component as
// `lastInvite.reason`. Read the status alone and this card shows a green Delivered tick beside mail
// that went to spam — and the host, told it arrived, stops looking. Mirrors the server test in
// app/src/server/__tests__/delivery.test.ts.

describe('a quarantined delivery does not get a green tick', () => {
  const quarantinedInvite = (reason: string) => payload({ guests: [guest({
    lastInvite: { status: 'delivered', reason, provider: 'mailgun', sentAt: 1_700_000_000_000, updatedAt: 0 },
  })] });

  it('says so on the closed row, where the host is scanning', () => {
    const { container } = render(GuestList, { props: { data: quarantinedInvite('2.0.0 OK DMARC:Quarantine') } });
    const s = summaryText(container);
    expect(s).toContain('Delivered to spam');
    expect(container.querySelector('details.guest-disc > summary .badge')?.className).toContain('warn');
  });

  it('and explains it inside the row, in words, above the server\'s raw reply', () => {
    const { container } = render(GuestList, { props: { data: quarantinedInvite('2.0.0 OK DMARC:Quarantine') } });
    const b = bodyText(container);
    expect(b).toContain('quarantined');
    expect(b).toContain('spam');
    // The server's own words stay, underneath. They are what an operator needs.
    expect(b).toContain('2.0.0 OK DMARC:Quarantine');
  });

  it('leaves an ordinary delivery exactly as it was', () => {
    const { container } = render(GuestList, { props: { data: quarantinedInvite('250 2.0.0 OK 1770146431 abc - gsmtp') } });
    const s = summaryText(container);
    expect(s).toContain('Delivered');
    expect(s).not.toContain('spam');
    expect(container.querySelector('details.guest-disc > summary .badge')?.className).toContain('good');
  });

  it('and a bounce is still a bounce even if DMARC is mentioned', () => {
    const { container } = render(GuestList, { props: { data: payload({ guests: [guest({
      lastInvite: { status: 'bounced', reason: '550 rejected: DMARC:quarantine policy', provider: 'mailgun', sentAt: 1, updatedAt: 0 },
    })] }) } });
    expect(summaryText(container)).toContain('Bounced');
  });
});
