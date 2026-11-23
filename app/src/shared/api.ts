// Shapes that cross the HTTP API between the server and the UI.

/** Whether the engine can take jobs. `failed` carries the reason. */
export type EngineStatus =
  | { state: 'loading' }
  | { state: 'ready' }
  | { state: 'failed'; error: string };
