import { mount } from 'svelte';
import '../src/app.css';
import App from './App.svelte';

mount(App, { target: document.getElementById('app')! });

// Only this browser-only guest shell gets an offline cache; the site's SSR worker is not bundled.
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/guest/sw.js', { scope: '/guest/', updateViaCache: 'none' })
      .catch((error) => console.warn('Guest offline cache unavailable', error));
  });
}
