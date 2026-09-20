<script lang="ts">
	/* The way back to the platform console — once, rather than once per page.
	 *
	 *  It existed twice and did not match: a red `.nav-link.site-admin` pill on the event manager,
	 *  and a plain `.btn ghost` on the dashboard. Svelte scopes CSS to the component that declares
	 *  it, so the manager's red could never reach the dashboard no matter how the classes were
	 *  named — one click apart, the same control was an unmistakable red pill on one page and
	 *  indistinguishable from "Sign out" on the other.
	 *
	 *  The manager's own comment already recorded that its metrics were kept in step with the
	 *  dashboard's buttons BY HAND. That is exactly what drifted the moment the red fill was added
	 *  to one side only. One file, for the same reason DownloadIcon is one file: so the surfaces
	 *  cannot come apart again.
	 *
	 *  Deliberately NOT a variant of the pages' `.btn`/`.nav-link` classes. Those are per-page and
	 *  scoped; this control's whole job is to look identical everywhere it appears. */
</script>

<a class="site-admin" href="/siteadmin" title="Back to the platform console" aria-label="Site admin">
	🎩<span class="lbl">Site admin</span>
</a>

<style>
	/* Metrics match the header buttons either side of it (padding, font, radius). The border is the
	   same colour as the fill rather than absent, so the pill stands exactly as tall as a bordered
	   neighbour instead of sitting 2px short — the original reason the manager's version carried
	   one. */
	.site-admin {
		display: inline-flex;
		align-items: center;
		gap: 7px;
		white-space: nowrap;
		text-decoration: none;
		font-weight: 700;
		font-size: 0.9rem;
		line-height: 1.2;
		padding: 10px 18px;
		border-radius: var(--radius-sm, 8px);
		background: #7a1f2b;
		color: #fff;
		border: 1px solid #7a1f2b;
		flex: none;
	}
	.site-admin:hover {
		background: #93202f;
		border-color: #93202f;
	}

	@media (max-width: 460px) {
		/* The mark stays and the words go. A red pill is unmistakable on its own, and the header is a
		   FIXED 62px: a third item that only site admins ever see is precisely what pushed the row
		   past that height and let the buttons spill over the bar's top and bottom edges. */
		.site-admin {
			padding: 7px 11px;
			font-size: 0.8rem;
		}
		.lbl {
			display: none;
		}
	}
</style>
