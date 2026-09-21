import { describe, it, expect } from 'vitest';
import BILLING_SRC from '../../../app/src/server/billing.ts?raw';
import PRICING_SRC from './pricing.ts?raw';

/* THE MARKETING COPY AND THE TILL MUST AGREE.
 *
 * `billing.ts` is the authority: it is what quote() charges and what the create and upgrade routes
 * entitle. `pricing.ts` is PROSE — hand-written marketing copy on the public pricing page — and it
 * restates those same numbers in sentences, because a tier table does not read like a sales page.
 *
 * Which means a price changed in billing.ts does not change what the site SAYS. There is nothing
 * structural stopping the two drifting, and they have drifted: the two-week duration tier was
 * added and the add-on sentence went on listing the old ladder, which pricing.ts's own comment
 * records. It was found by eye.
 *
 * That gap is a refund-and-bad-review generator rather than a cosmetic bug: somebody reads A$5,
 * is charged A$7, and is right to be annoyed. It is also about to get worse — the Etsy channel
 * introduces a SECOND pricing surface (bundle tiers) that has to agree with what a redeemed pass
 * actually grants, and adding a second surface on top of an unguarded first is how this becomes
 * expensive.
 *
 * This test does not make the copy generated — prose should stay prose. It reads the NUMBERS back
 * out of the sentences and holds them against the authority, so the sentence may be rewritten
 * freely and only a changed figure fails.
 */

/** One `export const NAME = <literal>;` out of billing.ts, evaluated. The same reader
 *  featureUpsell.test.ts uses — billing.ts cannot be imported for real, it pulls in Stripe. */
function serverConst<T>(name: string): T {
	const head = `export const ${name} = `;
	const at = BILLING_SRC.indexOf(head);
	if (at < 0) throw new Error(`billing.ts no longer exports ${name}`);
	let depth = 0, i = at + head.length, out = '';
	for (; i < BILLING_SRC.length; i++) {
		const c = BILLING_SRC[i];
		if (c === '[' || c === '{') depth++;
		else if (c === ']' || c === '}') depth--;
		else if (c === ';' && depth === 0) break;
		out += c;
	}
	const literal = out.replace(/\/\/[^\n]*/g, '').replace(/\bas const\b/, '').trim();
	return Function(`"use strict"; return (${literal});`)() as T;
}

/** The copy, with its own explanatory comments stripped — those discuss prices too, and a comment
 *  is not what a customer reads. Four source-shape tests in this repo have already been caught
 *  matching prose instead of code. */
const COPY = PRICING_SRC.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/^[ \t]*\/\/.*$/gm, ' ');

const dollars = (cents: number) => `A$${Math.round(cents / 100)}`;

type Tier = { maxGuests: number; amountCents: number };
type Rung = { amountCents: number };

describe('the pricing page says what the till charges', () => {
	it('every paid guest tier is priced as billing.ts prices it', () => {
		const tiers = serverConst<Tier[]>('PAID_TIERS');
		expect(tiers.length, 'a tier was added or removed — the copy needs the same change').toBeGreaterThan(0);
		for (const t of tiers) {
			// The line that names this guest count must carry this price. Matched together, so a
			// price that belongs to a different rung cannot satisfy it.
			const line = COPY.split('\n').find((l) => l.includes(`Up to ${t.maxGuests} guests`));
			expect(line, `the pricing page never mentions the ${t.maxGuests}-guest tier`).toBeTruthy();
			expect(line, `the ${t.maxGuests}-guest tier costs ${dollars(t.amountCents)} at the till`)
				.toContain(`'${dollars(t.amountCents)}'`);
		}
	});

	it('names every tier the ladder can sell, and invents none', () => {
		// Drift in the other direction: a tier removed from billing.ts but left on the page sells
		// something that cannot be bought, and quote() would price the request at the rung below.
		const tiers = serverConst<Tier[]>('PAID_TIERS');
		const advertised = [...COPY.matchAll(/Up to (\d+) guests/g)].map((m) => Number(m[1]));
		const free = serverConst<number>('FREE_ALL_GUESTS');
		expect(advertised.sort((a, b) => a - b))
			.toEqual([free, ...tiers.map((t) => t.maxGuests)].sort((a, b) => a - b));
	});

	it('the free tier is the free tier', () => {
		const free = serverConst<number>('FREE_ALL_GUESTS');
		const line = COPY.split('\n').find((l) => l.includes(`Up to ${free} guests`));
		expect(line, `the page must offer the ${free}-guest free tier`).toBeTruthy();
		expect(line).toContain("'Free'");
	});

	it('the longer-event ladder is quoted rung for rung', () => {
		// The sentence that drifted last time. Every paid duration rung's price must appear in it.
		const rungs = serverConst<Rung[]>('DURATION_TIERS').filter((r) => r.amountCents > 0);
		const line = COPY.split('\n').find((l) => l.includes('Longer event window'));
		expect(line, 'the longer-event add-on is no longer described').toBeTruthy();
		for (const r of rungs) {
			expect(line, `duration rung ${dollars(r.amountCents)} is missing from the copy`)
				.toContain(`+${dollars(r.amountCents)}`);
		}
		// And the free allowance it opens with.
		expect(line).toContain(`${serverConst<number>('DURATION_FREE_HOURS')}h free`);
	});

	it('the retention ladder is quoted rung for rung', () => {
		const rungs = serverConst<Rung[]>('RETENTION_TIERS').filter((r) => r.amountCents > 0);
		const line = COPY.split('\n').find((l) => l.includes('Photos kept'));
		expect(line, 'the retention add-on is no longer described').toBeTruthy();
		// The included month is free ON A PAID EVENT, so its rung price is never quoted as an
		// add-on — everything above it is.
		const paidDays = serverConst<number>('RETENTION_PAID_DAYS');
		for (const r of rungs.slice(1)) {
			expect(line, `retention rung ${dollars(r.amountCents)} is missing from the copy`)
				.toContain(`+${dollars(r.amountCents)}`);
		}
		expect(line, 'the included retention on a paid event').toContain(`${paidDays} days`);
		expect(line, 'and what a free event keeps').toContain(`${serverConst<number>('RETENTION_FREE_DAYS')} days`);
	});

	it('the one-off add-ons carry their real prices', () => {
		const frame = serverConst<number>('FRAME_PACK_CENTS');
		const brand = serverConst<number>('BRANDING_REMOVAL_CENTS');
		const shapes = COPY.split('\n').find((l) => l.includes('Extra photo shapes'));
		const slideshow = COPY.split('\n').find((l) => l.includes('intro and outro'));
		expect(shapes, 'the frame pack is no longer described').toBeTruthy();
		expect(shapes).toContain(`+${dollars(frame)}`);
		// It is free inside the free-features tier, and the copy says so with a number.
		expect(shapes).toContain(`up to ${serverConst<number>('FREE_ALL_GUESTS')} guests`);
		expect(slideshow, 'branding removal is no longer described').toBeTruthy();
		expect(slideshow).toContain(`+${dollars(brand)}`);
	});

	it('the included shot count matches what a guest actually gets', () => {
		const line = COPY.split('\n').find((l) => l.includes('More shots per guest'));
		expect(line, 'the shots add-on is no longer described').toBeTruthy();
		expect(line).toContain(`${serverConst<number>('SHOTS_FREE')} included`);
	});
});
