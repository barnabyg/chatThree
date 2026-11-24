import { useEffect, useState } from 'react';
import type { EngineStatus } from '../shared/api.ts';

/** The engine's status, or `disconnected` when the app itself cannot be reached. */
type Shown = EngineStatus | { state: 'disconnected' };

const LABELS: Record<Shown['state'], string> = {
  loading: 'Engine loading…',
  ready: 'Engine ready',
  failed: 'Engine failed',
  disconnected: 'chatThree is not running',
};

function useEngineStatus(): Shown {
  const [status, setStatus] = useState<Shown>({ state: 'loading' });
  useEffect(() => {
    // The browser reconnects an EventSource by itself, and the server sends
    // the current status on every connection.
    const events = new EventSource('/api/engine/events');
    events.addEventListener('status', (event: MessageEvent<string>) => {
      setStatus(JSON.parse(event.data) as EngineStatus);
    });
    events.addEventListener('error', () => {
      setStatus({ state: 'disconnected' });
    });
    return () => {
      events.close();
    };
  }, []);
  return status;
}

export function EngineStatusPanel() {
  const status = useEngineStatus();
  const [restarting, setRestarting] = useState(false);

  const restart = async (): Promise<void> => {
    setRestarting(true);
    try {
      await fetch('/api/engine/restart', { method: 'POST' });
    } finally {
      setRestarting(false);
    }
  };

  return (
    <section className="engine" aria-label="Engine">
      <p className={`engine-state engine-${status.state}`} role="status">
        {LABELS[status.state]}
      </p>
      {status.state === 'failed' && (
        <>
          <pre className="engine-error">{status.error}</pre>
          <button
            type="button"
            disabled={restarting}
            onClick={() => void restart()}
          >
            Restart engine
          </button>
        </>
      )}
    </section>
  );
}
