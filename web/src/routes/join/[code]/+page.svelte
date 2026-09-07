<script lang="ts">
  import { page } from '$app/stores';
  import Camera from '$lib/components/Camera.svelte';
  import OgHead from '$lib/components/OgHead.svelte';
  import type { PageData } from './$types';
  import { onMount } from 'svelte';
  import { track } from '$lib/analytics';
  export let data: PageData;

  // Top of the guest funnel: the link was opened. Deliberately separate from 'joined', because the
  // gap between them is guests who arrived and backed out.
  onMount(() => track('join_opened', undefined, $page.params.code ?? ''));
</script>

<OgHead og={data.og} />
<Camera identifier={$page.params.code ?? ''} />
