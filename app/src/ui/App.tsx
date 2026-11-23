import { useSyncExternalStore } from 'react';
import { ChatPage } from './ChatPage.tsx';
import { EngineStatusPanel } from './EngineStatus.tsx';
import { SettingsPage } from './SettingsPage.tsx';

function subscribeToHash(onChange: () => void): () => void {
  window.addEventListener('hashchange', onChange);
  return () => {
    window.removeEventListener('hashchange', onChange);
  };
}

/** The current route: the part of the URL after `#`, such as `/settings`. */
function useRoute(): string {
  return useSyncExternalStore(
    subscribeToHash,
    () => window.location.hash.slice(1) || '/',
  );
}

function Page({ route }: { route: string }) {
  if (route === '/settings') return <SettingsPage />;
  return <ChatPage />;
}

function NavLink({
  to,
  route,
  children,
}: {
  to: string;
  route: string;
  children: string;
}) {
  return (
    <a href={`#${to}`} aria-current={route === to ? 'page' : undefined}>
      {children}
    </a>
  );
}

export function App() {
  const route = useRoute();
  return (
    <div className="shell">
      <aside className="sidebar">
        <p className="brand">chatThree</p>
        <nav aria-label="Main">
          <NavLink to="/" route={route}>
            Chat
          </NavLink>
          <NavLink to="/settings" route={route}>
            Settings
          </NavLink>
        </nav>
        <EngineStatusPanel />
      </aside>
      <main className="main">
        <Page route={route} />
      </main>
    </div>
  );
}
