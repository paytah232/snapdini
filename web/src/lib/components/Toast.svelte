<script lang="ts">
  import { toast } from '$lib/toast';
</script>

{#if $toast}
  <div class="toast {$toast.kind}" role="status">{$toast.msg}</div>
{/if}

<style>
  .toast {
    position: fixed; left: 50%; bottom: 28px; transform: translateX(-50%);
    background: var(--surface); color: var(--text); border: 1px solid var(--border);
    padding: 12px 18px; border-radius: 999px; font-size: 0.88rem; font-weight: 600;
    box-shadow: 0 10px 30px rgba(0, 0, 0, 0.35); z-index: 9999; max-width: 90vw; text-align: center;
  }
  .toast.error { border-color: var(--danger); color: var(--danger); }
  .toast.success { border-color: var(--success); color: var(--success); }
</style>
