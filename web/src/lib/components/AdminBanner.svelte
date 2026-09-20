<script lang="ts">
	/* The "you are operating as the platform, not as a host" bar — once, rather than once per page.
	 *
	 *  Same reasoning as SiteAdminLink, and the same failure waiting to happen: the console declared
	 *  the red bar in its own stylesheet, and Svelte scopes CSS to the component that declares it,
	 *  so the second surface that needed one could only have got it by copying forty lines across.
	 *  A look that is copied is a look that drifts, and this is the one element in the product whose
	 *  whole job is to be instantly recognisable — a bar that is nearly the console's red reads as
	 *  decoration, not as a warning.
	 *
	 *  The console is not the dangerous surface. It is the one place the operator already KNOWS
	 *  where he is: it has its own layout, its own tables, nothing that looks like a host's screen.
	 *  The event manager is the danger, because it is pixel-for-pixel the screen a host sees of
	 *  their own event. So the bar matters more there — which is why it can stick.
	 *
	 *  `sticky` keeps it pinned. Off by default, because the console does not need it and a second
	 *  sticky element on a page that already has one is a height negotiation nobody asked for.
	 */
	export let sticky = false;
	/** WHERE it pins, when `sticky` is on. Any CSS length.
	 *
	 *  It was `var(--nav-h)` hard-coded, which is not a default so much as an assumption: that every
	 *  surface wanting this bar sits under the fixed site nav. The review screen does not have one —
	 *  its own header is the thing at `top: 0` — so the bar parked 62px down with a strip of page
	 *  scrolling above it, and that route had to wrap the component in a sticky <div> of its own to
	 *  get it to the top. A wrapper is a fiddly thing to have to work out from scratch, too: a
	 *  `position: sticky` child can only travel inside its parent's box, so the snug <div> you reach
	 *  for first does not stick at all.
	 *
	 *  The nav's height stays the DEFAULT, because that is where most callers want it and a caller
	 *  that says nothing is a caller with a site nav above it. */
	export let top = 'var(--nav-h, 62px)';
	/** Drop the full-bleed negative margin and the gap underneath.
	 *
	 *  The margin below assumes a 16px-padded page column to bleed into and something with breathing
	 *  room beneath. Both are true on the manager and in the console; neither is true on review,
	 *  where there is no gutter for the negative margin to cancel — so it pushes a horizontal
	 *  scrollbar — and the next thing down is a sticky header that has to meet this bar exactly.
	 *
	 *  A prop rather than letting callers reach in with `:global(.admin-banner)`. They can, and one
	 *  did, but a `:global` rule is global: it is scoped to nothing and applies to every copy of
	 *  this bar in the app, which is precisely the drift this component was extracted to prevent. */
	export let flush = false;
	/** Read OUT, via `bind:height`. The event manager stacks its own sticky section bar directly
	 *  under this one, and the offset has to be the bar's REAL height — it wraps to two rows on a
	 *  phone and at long customer names, so a constant would either leave a strip of page scrolling
	 *  between the two bars or park the lower one underneath this. Measured here because this is the
	 *  only place that can: Svelte has no `bind:clientHeight` on a component. */
	export let height = 0;
</script>

<!-- `--ab-top` only when it is actually sticky, and `undefined` rather than '' so the attribute is
     not emitted at all on the surfaces that do not stick — a stray empty style= on the console's
     bar is the kind of thing that gets copied. -->
<div class="admin-banner" class:sticky class:flush role="status" bind:clientHeight={height}
	style={sticky ? `--ab-top:${top}` : undefined}>
	<span class="msg"><slot /></span>
	<span class="acts"><slot name="actions" /></span>
</div>

<style>
	/* Full-bleed within a 16px-padded page column, so it reads as a BAR rather than a red strip with
	   the page showing down either side. Both callers' wrappers pad 16px; a caller that does not can
	   override the margin from outside. */
	.admin-banner {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 12px;
		flex-wrap: wrap;
		background: #7a1f2b;
		color: #fff;
		font-weight: 800;
		letter-spacing: 0.02em;
		margin: 0 -16px 18px;
		padding: 10px 18px;
		font-size: 0.86rem;
		border-bottom: 3px solid #c0392b;
	}
	/* Default is under the site nav, which is `position: sticky; top: 0; z-index: 50` and var(--nav-h)
	   tall. z-index 30 sits above the manager's own section bar (20) and below the nav, so the three
	   stack in the order you read them — and on review it clears that route's header (10) and stays
	   under its full-screen view (90) and caption modal (260).
	   The fallback inside the fallback is not belt-and-braces: --ab-top is absent whenever `sticky`
	   is off, and this rule only applies when it is on, but a rule that reads correctly on its own
	   is one nobody has to go and check the markup for. */
	.admin-banner.sticky {
		position: sticky;
		top: var(--ab-top, var(--nav-h, 62px));
		z-index: 30;
	}
	/* See `flush`. Nothing else about the bar changes — the colour, the type and the chip are the
	   whole reason this is one component. */
	.admin-banner.flush {
		margin: 0;
	}
	.msg {
		display: flex;
		align-items: center;
		gap: 8px;
		flex-wrap: wrap;
		min-width: 0;
	}
	.acts {
		display: flex;
		align-items: center;
		gap: 8px;
		flex-wrap: wrap;
	}

	/* :global, because slotted markup belongs to the CALLER and carries the caller's scope — the
	   whole reason the two versions of this bar could never have shared a stylesheet by being named
	   the same thing. Scoped under .admin-banner so it cannot leak past this bar. */
	.admin-banner :global(.exit),
	.admin-banner :global(.ab-btn) {
		color: #fff;
		text-decoration: none;
		font-weight: 700;
		font-size: 0.82rem;
		font-family: inherit;
		border: 1px solid rgba(255, 255, 255, 0.5);
		border-radius: 8px;
		padding: 4px 10px;
		white-space: nowrap;
		background: transparent;
		cursor: pointer;
		line-height: 1.4;
	}
	.admin-banner :global(.exit:hover),
	.admin-banner :global(.ab-btn:hover) {
		background: rgba(255, 255, 255, 0.15);
	}
	/* The one action that changes what the page will let you do gets filled in, so it does not read
	   as a third way out of here. */
	.admin-banner :global(.ab-btn.strong) {
		background: #fff;
		color: #7a1f2b;
		border-color: #fff;
	}
	.admin-banner :global(.ab-btn.strong:hover) {
		background: #f2e7e8;
	}
	/* The state word, said as a chip rather than as more of the same bold sentence: "READ-ONLY" and
	   "EDITING" have to be tellable apart at a glance from across a desk. */
	.admin-banner :global(.ab-chip) {
		font-size: 0.74rem;
		font-weight: 800;
		letter-spacing: 0.06em;
		border-radius: 999px;
		padding: 2px 9px;
		background: rgba(0, 0, 0, 0.28);
		white-space: nowrap;
	}
	.admin-banner :global(.ab-chip.live) {
		background: #fff;
		color: #7a1f2b;
	}
	/* The customer's name. Regular weight inside a bold bar so the NAME is what your eye lands on
	   rather than the shouting around it. */
	.admin-banner :global(.ab-who) {
		font-weight: 600;
		opacity: 0.95;
	}

	@media (max-width: 460px) {
		/* The bar wraps to two rows on a phone, which is fine — it is meant to be in the way. What is
		   not fine is it eating a third of the viewport, so the padding and type come down. */
		.admin-banner {
			font-size: 0.78rem;
			padding: 8px 12px;
			gap: 8px;
		}
	}
</style>
