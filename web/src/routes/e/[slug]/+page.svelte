<script lang="ts">
  import { page } from '$app/stores';
  import Camera from '$lib/components/Camera.svelte';
  import OgHead from '$lib/components/OgHead.svelte';
  import type { PageData } from './$types';
  export let data: PageData;
</script>

<OgHead og={data.og} />
<Camera identifier={$page.params.slug ?? ''} />
