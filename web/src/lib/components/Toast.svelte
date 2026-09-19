<script lang="ts">
  import { toast } from '$lib/toast';
</script>

{#if $toast}
  <div class="toast {$toast.kind}" role="status">{$toast.msg}</div>
{/if}

<style>
  .toast {
    /* Liftable: screens with their own bottom furniture raise --toast-bottom so a message never
       lands on top of a control. The camera does exactly that — a warning sitting over the shutter
       and the photo/video toggle is worse than no warning, because it blocks the thing you were
       reaching for. */
    position: fixed; left: 50%; bottom: var(--toast-bottom, 28px); transform: translateX(-50%);
    background: var(--surface); color: var(--text); border: 1px solid var(--border);
    padding: 13px 20px; font-size: 0.88rem; font-weight: 600; line-height: 1.4;
    /* Not a pill: these messages are often two or three lines, and a pill around wrapped text reads
       as cramped. Large enough to still look pill-ish on a single line. */
    border-radius: 16px;
    box-shadow: 0 10px 30px rgba(0, 0, 0, 0.35); z-index: 9999;
    width: max-content; max-width: min(92vw, 520px); text-align: center;
  }
  .toast.error { border-color: var(--danger); color: var(--danger); }
  .toast.success { border-color: var(--success); color: var(--success); }
  /* Twice the border weight and a ring of the same colour around it. The other kinds only recolour
     their border, which is enough when the message is a result being read at leisure; a hint has to
     win against the host's own finger and whatever it is resting on. The text stays plain — the
     ring does the work, so the words are no harder to read than any other toast.
     If color-mix is not supported the whole shadow declaration is dropped and the base .toast
     shadow above applies, which is the right thing to fall back to. */
  .toast.hint {
    border: 2px solid var(--accent);
    box-shadow: 0 10px 30px rgba(0, 0, 0, 0.35),
                0 0 0 4px color-mix(in srgb, var(--accent) 22%, transparent);
  }
</style>
