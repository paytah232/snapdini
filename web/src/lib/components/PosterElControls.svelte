<script lang="ts">
  // ── The selected element's own controls ─────────────────────────────────────
  //
  // Tapping an element on the poster used to open its text box on the spot, which is intrusive:
  // selecting a line to nudge it threw a keyboard over the design. So a tap SELECTS, and the
  // selected element carries this little cluster — its name, a pencil to open the editor, a bin,
  // and a cross to let go of it.
  //
  // A component rather than markup in PosterModal.svelte because it is needed TWICE, once on the
  // poster stage and once on the card stage, which measure in two different design spaces. Every
  // number arrives already converted to a percentage of whichever stage this is sitting in, so
  // there is nothing here that knows which surface it is on.
  //
  // There is only ever ONE of these per stage, because selection is exclusive — that is what makes
  // a single cluster possible instead of one hung off every element in three separate loops.
  export let label: string;
  /** The element's right edge and its top/bottom edges, as percentages of the stage. */
  export let rightPct: number;
  export let topPct: number;
  export let bottomPct: number;
  /** Sit under the element instead of over it — for an element near the top of the page, where
   *  there is no room above and the sheet would clip it. */
  export let below = false;
  /** Does this element have words the host can write? The footer is the join URL, the mark is fixed
   *  wording and the QR is an image, so none of those get a pencil. */
  export let canEdit = false;
  /** What the bin will do, already worded — or null for an element that has no honest delete. */
  export let binText: string | null = null;
  /** Armed, awaiting its second press. Shown by COLOUR alone, so the chip cannot change size
   *  between the arming press and the confirming one and shift the other controls out from under a
   *  thumb. The header's two confirms stack two labels for the same reason; a 44px chip has no room
   *  for a word, and the owner asked for the red highlight instead. */
  export let armed = false;
  /** Omitted where `canEdit` is false — a cluster with no pencil never calls it. */
  export let onEdit: () => void = () => {};
  export let onBin: () => void;
  export let onRelease: () => void;
  /** Is this element currently turned? The reset only exists while there is something to reset —
   *  a permanent "🔄 Upright" beside an upright element is a control for a state you are already in,
   *  and on a 316px stage there is no room to spend on one. */
  export let rotatedBy = 0;
  /** Put it back upright. Same glyph as the header's Reset layout and as the placed-motif panel's
   *  own reset, because all three mean the one thing: put it back where it started. They were two
   *  vocabularies — a single curved arrow here and on the motif panel, the recycle pair in the
   *  header — which made the same promise look like two different offers depending on where you
   *  found it. Changed in all three places together; one of them left behind is the whole problem. */
  export let onUpright: () => void = () => {};
  /** Take me to this element's own controls. Null for an element with nowhere to go — the cluster
   *  then has no cog, rather than a cog that leads somewhere unrelated. */
  export let onSettings: (() => void) | null = null;
</script>

<!-- `left: 0` with `right` pinned to the element's right edge, rather than a left offset: the strip
     then right-aligns to the element and CLAMPS at the stage's left edge on its own, so a cluster
     wider than the element it belongs to cannot run off the side of a 316px phone preview. -->
<div class="el-ctl" class:below
     style={below ? `left:0; right:${100 - rightPct}%; top:${bottomPct}%`
                  : `left:0; right:${100 - rightPct}%; bottom:${100 - topPct}%`}>
  <!-- The element's name, moved here from the `.el-name` tab it replaces while selected — same
       pill, same type, just at the other end of the element so it is not under the buttons. -->
  <span class="ec-name">{label}</span>
  {#if onSettings}
    <!-- The way back into the panel from the thing itself. The designer already had the opposite
         journey — hovering a control outlines the element it affects — and this is the one people
         actually need: you are looking at the title and you want its colour, not hunting a field
         whose name you have to guess. The PENCIL keeps the words; this is everything else about
         how the element looks, which is why they can sit side by side without overlapping. -->
    <button class="ec-b" on:click|stopPropagation={onSettings}
            aria-label="{label} settings" title="{label} settings"><span class="ec-i">⚙️</span></button>
  {/if}
  {#if canEdit}
    <!-- stopPropagation on every one of these: the window-level click handler disarms the confirms,
         and without it the bin's own arming press would immediately undo itself. The same note
         sits on the header's "Start again". -->
    <button class="ec-b" on:click|stopPropagation={onEdit}
            aria-label="Edit {label}" title="Edit {label}"><span class="ec-i">✏️</span></button>
  {/if}
  {#if rotatedBy}
    <!-- The angle is IN the label rather than printed beside it: the strip already right-aligns to
         the element and clamps at the stage's edge, and a fifth chip's worth of text is what would
         push the ✕ off a narrow preview. -->
    <button class="ec-b" on:click|stopPropagation={onUpright}
            aria-label="Put {label} upright — it is turned {Math.round((rotatedBy * 180) / Math.PI)} degrees"
            title="🔄 Upright ({Math.round((rotatedBy * 180) / Math.PI)}°)"><span class="ec-i">🔄</span></button>
  {/if}
  {#if binText}
    <button class="ec-b bin" class:armed on:click|stopPropagation={onBin}
            aria-label={binText} title={binText}><span class="ec-i">🗑️</span></button>
  {/if}
  <!-- Not confusable with the modal's ✕, which is a bare muted glyph in the sticky header: this one
       is a filled chip on the canvas, pinned to the element and moving with it, 44px rather than a
       1rem glyph, flanked by a pencil and a bin, and it exists only while something is selected.
       It also says what it closes — "Done with the Title", not "Close". -->
  <button class="ec-b done" on:click|stopPropagation={onRelease}
          aria-label="Done with {label}" title="Done with {label}"><span class="ec-i">✕</span></button>
</div>

<style>
  /* The strip is mostly air. Only the buttons take taps, so the gaps between them fall through to
     whatever element is underneath rather than swallowing a press. */
  .el-ctl {
    position: absolute; z-index: 4; pointer-events: none;
    display: flex; align-items: center; justify-content: flex-end; gap: 2px;
  }
  .el-ctl:not(.below) { margin-bottom: 3px; }
  .el-ctl.below { margin-top: 3px; }
  /* Shrinks before the buttons do — they are fixed 44px targets and the name is the only thing here
     that can afford to give way on a narrow stage. */
  .ec-name {
    flex: 0 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
    background: rgba(17, 17, 17, 0.82); color: #fff; font-size: 0.55rem; font-weight: 700;
    letter-spacing: 0.02em; padding: 1px 6px; border-radius: 5px; line-height: 1.25;
  }
  /* 44px, not the 30px the chip inside it draws. This is operated one-handed at a party, and a hit
     area shrunk to fit an icon is how a host ends up pressing the poster instead of the button. */
  .ec-b {
    flex: none; width: 44px; height: 44px; padding: 0; border: 0; background: none;
    display: inline-flex; align-items: center; justify-content: center;
    cursor: pointer; pointer-events: auto; touch-action: manipulation;
  }
  /* Self-contained rather than theme-following, exactly like the resize grip it sits beside: these
     chips are drawn ON the poster, which can be any colour the host chose, so a ground that tracked
     the app's surface colour would vanish on half the designs. */
  .ec-i {
    display: inline-flex; align-items: center; justify-content: center;
    width: 30px; height: 30px; border-radius: 8px; font-size: 0.8rem; line-height: 1;
    color: #111; background: rgba(255, 255, 255, 0.94); border: 1px solid var(--accent);
    box-shadow: 0 1px 4px rgba(0, 0, 0, 0.35);
  }
  .ec-b.done .ec-i { background: var(--accent-fill); color: var(--accent-ink, #111); }
  /* Armed. COLOUR only — no size, no border width, no padding changes — so nothing in the cluster
     moves between the two presses. */
  .ec-b.bin.armed .ec-i { background: var(--danger, #e0483d); border-color: var(--danger, #e0483d); color: #fff; }
</style>
