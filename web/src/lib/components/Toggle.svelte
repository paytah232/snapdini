<!--
  The on/off switch, once.

  It existed as markup-plus-CSS inside the create wizard and nowhere else, which is why every other
  screen in the product asked the same kind of question with a checkbox: there was no switch to
  reach for. Svelte scopes styles to their component, so "use the toggle here too" meant copying
  forty lines of CSS into another file — and a look that is copied is a look that drifts.

  WHEN TO USE IT. A toggle is for a SETTING: one thing that is on or off, that takes effect as soon
  as it changes, and that the person can flip back. It is not a checkbox replacement:

    · Consent stays a checkbox. "I agree to…" is an affirmative act, and a pre-styled switch that
      can be nudged is the wrong shape for something a person must deliberately assert.
    · Choosing several things from a list stays a checkbox — frame shapes, who to send to. Those
      are a selection, not a state, and a column of switches reads as ten settings rather than one
      question with ten answers.
-->
<script lang="ts">
  /** The state. Bindable: `<Toggle bind:checked={noFlash} />`. */
  export let checked = false;
  /** Set when a <label for=…> elsewhere names this control. */
  export let id: string | undefined = undefined;
  export let disabled = false;
  /** Only needed when nothing else labels it — a visible <label for={id}> is better. */
  export let ariaLabel: string | undefined = undefined;
</script>

<!-- The native checkbox is kept and merely hidden, rather than replaced by a div with role=switch:
     it already carries the keyboard behaviour, the form semantics and the screen-reader state, and
     every hand-rolled version of this loses at least one of them. -->
<label class="toggle" class:disabled>
  <input
    type="checkbox"
    {id}
    {disabled}
    aria-label={ariaLabel}
    bind:checked
    on:change
  />
  <span class="toggle-track"></span>
</label>

<style>
  .toggle {
    position: relative;
    display: inline-block;
    width: 46px;
    height: 26px;
    flex-shrink: 0;
    /* The real input is width:0 and transparent, so the <label> wrapper is the entire hit area —
       and without this it inherits the page's default arrow and reads as decoration rather than as
       something you can press. Every other control in the product shows a hand. */
    cursor: pointer;
  }
  /* Later and more specific, so it wins over the rule above. */
  .toggle.disabled { opacity: 0.5; cursor: not-allowed; }
  .toggle input {
    position: absolute;
    opacity: 0;
    width: 0;
    height: 0;
  }
  .toggle-track {
    position: absolute;
    inset: 0;
    background: var(--surface-2);
    border: 1px solid var(--border);
    border-radius: 999px;
    transition: background 0.15s;
  }
  .toggle-track::before {
    content: '';
    position: absolute;
    width: 18px;
    height: 18px;
    left: 3px;
    top: 3px;
    background: var(--text-muted);
    border-radius: 50%;
    transition: transform 0.15s, background 0.15s;
  }
  .toggle input:checked + .toggle-track {
    background: var(--accent-fill);
    border-color: var(--accent);
  }
  .toggle input:checked + .toggle-track::before {
    transform: translateX(20px);
    background: #111;
  }
  /* The original had none: the real checkbox is width:0 and transparent, so a keyboard user tabbing
     through a settings panel could not see where they were. */
  .toggle input:focus-visible + .toggle-track {
    outline: 2px solid var(--accent);
    outline-offset: 2px;
  }
  @media (prefers-reduced-motion: reduce) {
    .toggle-track, .toggle-track::before { transition: none; }
  }
</style>
