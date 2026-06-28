<script lang="ts">
  import type { OgData } from '$lib/server/og';
  export let og: OgData | undefined = undefined;
</script>

<svelte:head>
  {#if og}
    <title>{og.title}</title>
    <meta name="description" content={og.description} />
    <meta property="og:type" content="website" />
    <meta property="og:site_name" content="Snapdini" />
    <meta property="og:title" content={og.title} />
    <meta property="og:description" content={og.description} />
    <meta property="og:url" content={og.url} />
    {#if og.image}
      <meta property="og:image" content={og.image} />
      <meta name="twitter:card" content="summary_large_image" />
      <meta name="twitter:image" content={og.image} />
    {:else}
      <meta name="twitter:card" content="summary" />
    {/if}
    <meta name="twitter:title" content={og.title} />
    <meta name="twitter:description" content={og.description} />
  {/if}
</svelte:head>
