// Register the service worker and auto-apply updates: when a new version activates and
// takes control, reload once so the user gets the latest build on a normal refresh —
// no hard-refresh / cache-clear needed. (First install doesn't reload.)
if ('serviceWorker' in navigator) {
  var hadController = !!navigator.serviceWorker.controller;
  navigator.serviceWorker.register('/sw.js').catch(function () {});
  var reloaded = false;
  navigator.serviceWorker.addEventListener('controllerchange', function () {
    if (reloaded || !hadController) return;   // skip reload on the very first install
    reloaded = true;
    location.reload();
  });
}
