import { CharacterEditor } from './CharacterEditor.tsx';
import { ChatList } from './ChatList.tsx';
import { ChatPage } from './ChatPage.tsx';
import { EngineStatusPanel } from './EngineStatus.tsx';
import { Home } from './Home.tsx';
import { CHARACTERS, LibraryPage, SCENARIOS } from './LibraryPage.tsx';
import { NewChatPage } from './NewChatPage.tsx';
import { useRoute } from './router.ts';
import { ScenarioEditor } from './ScenarioEditor.tsx';
import { SettingsPage } from './SettingsPage.tsx';

/** A route such as `/chats/new?character=abc`, taken apart. */
interface Route {
  section: string | undefined;
  id: string | undefined;
  query: URLSearchParams;
}

function parse(route: string): Route {
  const [path = '', query = ''] = route.split('?');
  const [, section, id] = path.split('/');
  return { section, id, query: new URLSearchParams(query) };
}

function Page({ section, id, query }: Route) {
  switch (section) {
    case 'chats':
      if (id === undefined) return <Home />;
      if (id === 'new') {
        return (
          <NewChatPage
            preselected={{
              characterId: query.get('character') ?? undefined,
              scenarioId: query.get('scenario') ?? undefined,
            }}
          />
        );
      }
      // Keyed, so that moving between chats starts each with a clean page.
      return <ChatPage key={id} chatId={id} />;
    case 'characters':
      if (id === undefined) return <LibraryPage kind={CHARACTERS} />;
      return id === 'new' ? (
        <CharacterEditor key="new" />
      ) : (
        <CharacterEditor key={id} id={id} />
      );
    case 'scenarios':
      if (id === undefined) return <LibraryPage kind={SCENARIOS} />;
      return id === 'new' ? (
        <ScenarioEditor key="new" />
      ) : (
        <ScenarioEditor key={id} id={id} />
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
  const route = parse(useRoute());
  const { section, id } = route;
  const currentChat = section === 'chats' && id !== 'new' ? id : undefined;
  return (
    <div className="shell">
      <aside className="sidebar">
        <p className="brand">chatThree</p>
        <a className="button primary" href="#/chats/new">
          New chat
        </a>
        <ChatList currentId={currentChat} />
        <nav aria-label="Main">
          <NavLink to="/characters" current={section === 'characters'}>
            Characters
          </NavLink>
          <NavLink to="/scenarios" current={section === 'scenarios'}>
            Scenarios
          </NavLink>
          <NavLink to="/settings" current={section === 'settings'}>
            Settings
          </NavLink>
        </nav>
        <EngineStatusPanel />
      </aside>
      <main className="main">
        <Page {...route} />
      </main>
    </div>
  );
}
