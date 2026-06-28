<script lang="ts">
  // A small "?" badge that reveals an explanation on hover or focus (works on touch via focus).
  export let text: string;
</script>

<button type="button" class="tip" aria-label={text}>?<span class="bubble">{text}</span></button>

<style>
  .tip {
    position: relative; display: inline-flex; align-items: center; justify-content: center;
    width: 15px; height: 15px; padding: 0; border-radius: 50%; border: 1px solid var(--border);
    background: transparent; color: var(--text-muted); font-size: 0.62rem; font-weight: 700; cursor: help;
    vertical-align: middle; margin-left: 4px; flex: none;
  }
  .bubble {
    position: absolute; bottom: calc(100% + 6px); left: 50%; transform: translateX(-50%);
    width: max-content; max-width: 230px; background: var(--surface-2); color: var(--text);
    border: 1px solid var(--border); border-radius: 8px; padding: 7px 9px;
    font-size: 0.72rem; font-weight: 400; line-height: 1.4; text-align: left; white-space: normal;
    box-shadow: 0 6px 20px rgba(0,0,0,0.3); opacity: 0; visibility: hidden; transition: opacity 0.12s; z-index: 60;
  }
  .tip:hover .bubble, .tip:focus .bubble { opacity: 1; visibility: visible; }
</style>
