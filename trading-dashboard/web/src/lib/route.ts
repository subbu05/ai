import { useSyncExternalStore } from "react";

/** Two pages, addressed by the URL hash so reloads and the back button work: #/ and #/taxes. */
export type Page = "trade" | "taxes";

const read = (): Page => (location.hash.replace(/^#\/?/, "") === "taxes" ? "taxes" : "trade");
const subscribe = (cb: () => void) => {
  window.addEventListener("hashchange", cb);
  return () => window.removeEventListener("hashchange", cb);
};

export const usePage = (): Page => useSyncExternalStore(subscribe, read, read);
export const goTo = (p: Page) => { location.hash = p === "taxes" ? "/taxes" : "/"; };
