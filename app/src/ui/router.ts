// Routes live in the URL's hash (`#/characters`), so the server needs to
// know nothing about them and the browser's back button works.

import { useSyncExternalStore } from 'react';

function subscribe(onChange: () => void): () => void {
  window.addEventListener('hashchange', onChange);
  return () => {
    window.removeEventListener('hashchange', onChange);
  };
}

/** The current route, such as `/characters`. `/` when there is none. */
export function useRoute(): string {
  return useSyncExternalStore(
    subscribe,
    () => window.location.hash.slice(1) || '/',
  );
}

/** Go to `route`. With `replace`, the current page is not kept in history. */
export function navigate(route: string, options?: { replace: boolean }): void {
  if (options?.replace === true) {
    window.location.replace(`#${route}`);
  } else {
    window.location.hash = route;
  }
}
