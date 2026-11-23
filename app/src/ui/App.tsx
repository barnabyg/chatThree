import { CharacterEditor } from './CharacterEditor.tsx';
import { CharactersPage } from './CharactersPage.tsx';
import { ChatPage } from './ChatPage.tsx';
import { EngineStatusPanel } from './EngineStatus.tsx';
import { Home } from './Home.tsx';
import { useRoute } from './router.ts';
import { SettingsPage } from './SettingsPage.tsx';

function Page({ route }: { route: string }) {
  const [, section, id] = route.split('/');
  switch (section) {
    case 'chats':
      // Keyed, so that moving between chats starts each with a clean page.
      return id === undefined ? <Home /> : <ChatPage key={id} chatId={id} />;
    case 'characters':
      if (id === undefined) return <CharactersPage />;
      return id === 'new' ? (
        <CharacterEditor key="new" />
      ) : (
        <CharacterEditor key={id} id={id} />
      );
    case 'settings':
      return <SettingsPage />;
    default:
      return <Home />;
  }
}

function NavLink({
  to,
  current,
  children,
}: {
  to: string;
  current: boolean;
  children: string;
}) {
  return (
    <a href={`#${to}`} aria-current={current ? 'page' : undefined}>
      {children}
    </a>
  );
}

export function App() {
  const route = useRoute();
  const section = route.split('/')[1] ?? '';
  return (
    <div className="shell">
      <aside className="sidebar">
        <p className="brand">chatThree</p>
        <nav aria-label="Main">
          <NavLink to="/" current={section === '' || section === 'chats'}>
            Chat
          </NavLink>
          <NavLink to="/characters" current={section === 'characters'}>
            Characters
          </NavLink>
          <NavLink to="/settings" current={section === 'settings'}>
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
