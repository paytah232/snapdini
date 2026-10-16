/** Guest camera navigation deliberately leaves this standalone page for other application routes. */
export async function goto(
  href: string | URL,
  options: { replaceState?: boolean } = {},
): Promise<void> {
  if (options.replaceState) window.location.replace(href.toString());
  else window.location.assign(href.toString());
}

/** Camera uses this only to remove consumed fragment parameters without navigating. */
export function replaceState(href: string | URL, state: unknown): void {
  window.history.replaceState(state, '', href.toString());
}
