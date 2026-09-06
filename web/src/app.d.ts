// See https://svelte.dev/docs/kit/types#app
declare global {
  namespace App {
    // interface Error {}
    // interface Locals {}
    // interface PageData {}
    // interface Platform {}
    /** Shallow-routing state. `sv` marks the single-photo view in Review & Curate, so Back closes
     *  the photo instead of leaving the route — declared here so it is typed rather than `any`. */
    interface PageState {
      sv?: boolean;
    }
  }
}

export {};
