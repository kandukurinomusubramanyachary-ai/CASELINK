import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { api, ApiError, hasAuthToken, SESSION_EXPIRED_EVENT, type SessionInfo } from './api';
import { Pill, ToastProvider, Loading, Modal } from './ui';
import { bureauName, classNames, roleLabel } from './util';
import { Brand, Icon, type IconName } from './components/Icon';
import { ThemeControl } from './theme';
import { HelpDialog } from './components/HelpDialog';
import { SearchDialog } from './components/SearchDialog';
import { BackToTop } from './components/BackToTop';

export interface AppCtx {
  session: SessionInfo;
  meta: any;
  refreshSession: () => Promise<void>;
  notifications: any[];
  refreshNotifications: () => Promise<void>;
  unread: number;
  go: (hash: string) => void;
}

const Ctx = createContext<AppCtx | null>(null);

export function useApp(): AppCtx {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error('useApp outside provider');
  return ctx;
}

/* --------------------------------------------------------------- routing */

function useHashRoute(): [string, (hash: string) => void] {
  const [hash, setHash] = useState(window.location.hash.replace(/^#/, '') || '/my-work');
  useEffect(() => {
    const onChange = () => setHash(window.location.hash.replace(/^#/, '') || '/my-work');
    window.addEventListener('hashchange', onChange);
    return () => window.removeEventListener('hashchange', onChange);
  }, []);
  const go = useCallback((next: string) => {
    if (window.location.hash.replace(/^#/, '') === next) {
      window.dispatchEvent(new HashChangeEvent('hashchange'));
      return;
    }
    window.location.hash = next;
  }, []);
  return [hash, go];
}

export function matchRoute(route: string): { name: string; param?: string; query: URLSearchParams } {
  const [path, search = ''] = route.split('?');
  const parts = path.split('/').filter(Boolean);
  const query = new URLSearchParams(search);
  if (parts.length === 0) return { name: 'my-work', query };
  if (parts[0] === 'cases' && parts[1]) return { name: 'case', param: parts[1], query };
  if (parts[0] === 'institutions' && parts[1]) return { name: 'institution', param: parts[1], query };
  if (parts[0] === 'overlaps' && parts[1]) return { name: 'overlaps', param: parts[1], query };
  if (parts[0] === 'coordination' && parts[1]) return { name: 'coordination-focus', param: parts[1], query };
  return { name: parts[0], query };
}

/* ----------------------------------------------------------------- shell */

const NAV: { id: string; label: string; icon: IconName }[] = [
  { id: 'my-work', label: 'My work', icon: 'work' },
  { id: 'institutions', label: 'Institutions', icon: 'institution' },
  { id: 'cases', label: 'Cases', icon: 'cases' },
  { id: 'coordination', label: 'Coordination', icon: 'coordination' },
  { id: 'overlaps', label: 'Overlap detection', icon: 'coordination' },
  { id: 'alerts', label: 'Alerts', icon: 'bell' },
  { id: 'reports', label: 'Reports', icon: 'reports' },
];

export function App() {
  useEffect(() => {
    const pointer = () => { document.documentElement.dataset.input = 'pointer'; };
    const keyboard = () => { document.documentElement.dataset.input = 'keyboard'; };
    window.addEventListener('pointerdown', pointer, { passive: true });
    window.addEventListener('keydown', keyboard);
    return () => { window.removeEventListener('pointerdown', pointer); window.removeEventListener('keydown', keyboard); };
  }, []);
  return (
    <ToastProvider>
      <Boot />
    </ToastProvider>
  );
}

const DEFAULT_DEMO_USER = 'm.nair';
const DEMO_USER_KEY = 'caselink.demoUser';
const SIGNED_OUT_KEY = 'caselink.signedOut';

function requestedDemoUser(route: string): string | null {
  const fromSearch = new URLSearchParams(window.location.search).get('as');
  if (fromSearch) return fromSearch;
  const hashQuery = route.split('?')[1];
  if (hashQuery) return new URLSearchParams(hashQuery).get('as');
  return null;
}

function Boot() {
  const [session, setSession] = useState<SessionInfo | null>(null);
  const [meta, setMeta] = useState<any>(null);
  const [notifications, setNotifications] = useState<any[]>([]);
  const [route, go] = useHashRoute();
  const [error, setError] = useState<ApiError | null>(null);

  /**
   * Session expiry (M7/A19): the API client reports a refused 401. Everything cached in this tab —
   * session, metadata, notifications, notification overlay and the rendered screens — is dropped, and
   * the sign-in form is shown. A pending response from the old session cannot repopulate the screen
   * because the protected view is unmounted.
   */
  useEffect(() => {
    const onExpired = () => {
      setSession({ authenticated: false });
      setMeta(null);
      setNotifications([]);
      setError(null);
      sessionStorage.removeItem(SIGNED_OUT_KEY);
      if (!window.location.hash.startsWith('#/login')) window.location.hash = '#/login';
    };
    window.addEventListener(SESSION_EXPIRED_EVENT, onExpired);
    return () => window.removeEventListener(SESSION_EXPIRED_EVENT, onExpired);
  }, []);

  const refreshSession = useCallback(async () => {
    try {
      const s = await api.session();
      setSession(s);
      if (s.authenticated) {
        const m = await api.meta();
        setMeta(m);
      }
    } catch (err) {
      setError(err as ApiError);
    }
  }, []);

  /**
   * Direct entry: in the demo build the workspace opens without a sign-in step, as the last used
   * synthetic account (bureau lead by default). An explicit sign-out in this tab is respected, and
   * `#/login` or `?as=<username>` override the default.
   */
  const bootstrap = useCallback(async () => {
    try {
      const s = await api.session();
      const current = window.location.hash.replace(/^#/, '') || '/my-work';
      // `?as=` identity switching exists only in an explicitly configured demo instance. In a normal
      // deployment neither the deep link nor any other shortcut can change the signed-in account.
      const requestedFirst = s.demoMode ? requestedDemoUser(current) : null;
      if (s.authenticated && (!requestedFirst || requestedFirst === s.user?.username)) {
        setSession(s);
        setMeta(await api.meta());
        return;
      }
      if (s.authenticated && requestedFirst) {
        // Explicit demo deep link: switch the synthetic account.
        const entered = await api.demoLogin(requestedFirst);
        localStorage.setItem(DEMO_USER_KEY, entered.user!.username);
        sessionStorage.removeItem(SIGNED_OUT_KEY);
        setSession(await api.session());
        setMeta(await api.meta());
        return;
      }
      const onLoginPage = current.startsWith('/login');
      const signedOut = sessionStorage.getItem(SIGNED_OUT_KEY) === '1';
      const requested = s.demoMode ? requestedDemoUser(current) : null;
      if (s.demoMode && !onLoginPage && (!signedOut || requested)) {
        const username = requested ?? localStorage.getItem(DEMO_USER_KEY) ?? DEFAULT_DEMO_USER;
        const entered = await api.demoLogin(username);
        localStorage.setItem(DEMO_USER_KEY, entered.user!.username);
        sessionStorage.removeItem(SIGNED_OUT_KEY);
        setSession(await api.session());
        setMeta(await api.meta());
        return;
      }
      setSession(s);
    } catch (err) {
      setError(err as ApiError);
      setSession((prev) => prev ?? { authenticated: false });
    }
  }, []);

  const refreshNotifications = useCallback(async () => {
    try {
      const n = await api.notifications();
      setNotifications(n.notifications);
    } catch {
      /* notification refresh failures must never block case work */
    }
  }, []);

  useEffect(() => {
    void bootstrap();
  }, [bootstrap]);

  useEffect(() => {
    if (!session?.authenticated) return;
    void refreshNotifications();
    const timer = setInterval(() => {
      // A hidden tab does no polling; becoming visible refreshes immediately (M6).
      if (hasAuthToken() && document.visibilityState === 'visible') void refreshNotifications();
    }, 10_000);
    return () => clearInterval(timer);
  }, [session?.authenticated, refreshNotifications]);

  const unread = notifications.filter((n) => !n.readAt).length;

  if (!session && !error) {
    return (
      <div className="content" style={{ maxWidth: 720, margin: '0 auto', paddingTop: 80 }}>
        <Loading label="Starting CaseLink…" rows={3} />
      </div>
    );
  }

  if (!session?.authenticated) {
    return (
      <LoginScreen
        session={session}
        onSignedIn={async () => {
          if (window.location.hash.startsWith('#/login') || window.location.hash === '') {
            window.location.hash = '#/my-work';
          }
          await refreshSession();
        }}
        bootError={error}
        onDirectEntry={async (username: string) => {
          const entered = await api.demoLogin(username);
          localStorage.setItem(DEMO_USER_KEY, entered.user!.username);
          sessionStorage.removeItem(SIGNED_OUT_KEY);
          if (window.location.hash !== '#/my-work') window.location.hash = '#/my-work';
          await refreshSession();
        }}
      />
    );
  }

  const ctx: AppCtx = {
    session,
    meta,
    refreshSession,
    notifications,
    refreshNotifications,
    unread,
    go,
  };

  return (
    <Ctx.Provider value={ctx}>
      <Shell route={route} go={go} />
    </Ctx.Provider>
  );
}

function Shell({ route, go }: { route: string; go: (hash: string) => void }) {
  const { session, unread, refreshSession, notifications, refreshNotifications } = useApp();
  const match = matchRoute(route);
  const user = session.user!;
  const [bellOpen, setBellOpen] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [help, setHelp] = useState<{ topic?: string } | null>(null);
  const bellRef = useRef<HTMLDivElement>(null);
  const bellButtonRef = useRef<HTMLButtonElement>(null);
  const menuButtonRef = useRef<HTMLButtonElement>(null);
  const counts = useMyWorkCounts();

  const activeNav = match.name === 'case' ? 'cases' : match.name === 'institution' ? 'institutions' : match.name === 'coordination-focus' ? 'coordination' : match.name;
  const pagePath = route.split('?')[0];

  useEffect(() => { setBellOpen(false); setMenuOpen(false); setSearchOpen(false); setHelp(null); window.scrollTo(0, 0); }, [pagePath]);
  useEffect(() => {
    const shortcut = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k' && !document.querySelector('dialog[open]')) { event.preventDefault(); setSearchOpen(true); }
    };
    document.addEventListener('keydown', shortcut);
    return () => document.removeEventListener('keydown', shortcut);
  }, []);
  useEffect(() => {
    const desktop = window.matchMedia('(min-width: 1024px)');
    const closeOnDesktop = () => { if (desktop.matches) setMenuOpen(false); };
    desktop.addEventListener('change', closeOnDesktop);
    return () => desktop.removeEventListener('change', closeOnDesktop);
  }, []);
  useEffect(() => {
    if (!bellOpen) return;
    bellRef.current?.querySelector<HTMLElement>('[role="dialog"] button')?.focus({ preventScroll: true });
    const outside = (event: PointerEvent) => {
      if (!bellRef.current?.contains(event.target as Node)) setBellOpen(false);
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { setBellOpen(false); bellButtonRef.current?.focus(); }
    };
    document.addEventListener('pointerdown', outside);
    document.addEventListener('keydown', escape);
    return () => { document.removeEventListener('pointerdown', outside); document.removeEventListener('keydown', escape); };
  }, [bellOpen]);

  const navigation = <Navigation activeNav={activeNav} unread={unread} overdue={counts.overdue} onNavigate={() => setMenuOpen(false)} />;

  return (
    <div className="shell">
      <a className="skip-link" href="#main-content" onClick={(event) => { event.preventDefault(); document.getElementById('main-content')?.focus(); }}>Skip to content</a>
      <aside className="sidebar">
        <Brand sub />
        {navigation}
        <div className="sidebar-foot">
          <button type="button" className="btn btn-ghost btn-sm" onClick={() => setHelp({})}><Icon name="help" size={18} />Help & privacy</button>
          <div className="sidebar-bureau">{bureauName(user.bureau)}</div>
          <div>{user.region ? `${user.region} region` : 'National scope'}</div>
          <div style={{ marginTop: 6 }}>Times shown in IST · events stored in UTC</div>
        </div>
      </aside>

      <div className="main">
        <div className="banner-demo">
          <strong>DEMO</strong>
          <span className="demo-copy-full">Fictional institutions, people and records. No government integration is active.</span>
          <span className="demo-copy-short">Fictional records. No government integration.</span>
        </div>
        <header className="topbar">
          <div className="topbar-left">
            <button ref={menuButtonRef} type="button" className="btn btn-ghost btn-icon menu-toggle" aria-label="Open navigation" aria-haspopup="dialog" aria-expanded={menuOpen} onClick={() => setMenuOpen(true)}><Icon name="menu" /></button>
            <div className="mobile-brand"><Brand /></div>
            <div className="desktop-context">
              <div className="crumb">{bureauName(user.bureau)}{user.region ? ` · ${user.region}` : ''}</div>
              <strong style={{ fontSize: 14 }}>{titleFor(match.name)}</strong>
            </div>
          </div>
          <div className="topbar-right">
            <button type="button" className="btn btn-ghost btn-sm search-trigger" aria-label="Search CaseLink" aria-keyshortcuts="Control+k Meta+k" onClick={() => setSearchOpen(true)}><Icon name="search" size={18} /><span>Search</span><kbd>⌘ / Ctrl K</kbd></button>
            <div className="desktop-theme"><ThemeControl compact /></div>
            <button type="button" className="btn btn-ghost btn-icon help-trigger" aria-label="Open help" onClick={() => setHelp({})}><Icon name="help" /></button>
            <div className="bell" ref={bellRef}>
              <button
                type="button"
                className="btn btn-ghost btn-icon"
                aria-label={`Notifications (${unread} unread)`}
                aria-expanded={bellOpen}
                aria-controls={bellOpen ? 'recent-notifications' : undefined}
                ref={bellButtonRef}
                onClick={() => setBellOpen((v) => !v)}
              >
                <Icon name="bell" />
                {unread > 0 && <span className="bell-count">{unread}</span>}
              </button>
              {bellOpen && (
                <NotificationPopover
                  notifications={notifications}
                  onClose={() => { setBellOpen(false); bellButtonRef.current?.focus(); }}
                  onChanged={refreshNotifications}
                  go={go}
                />
              )}
            </div>
            {session.demoAccounts && session.demoAccounts.length > 0 && (
              <label className="switcher">
                <span className="small muted">Demo account</span>
                <select
                  value={user.username}
                  onChange={async (e) => {
                    const next = e.target.value;
                    try {
                      await api.demoLogin(next);
                      localStorage.setItem(DEMO_USER_KEY, next);
                      window.location.hash = '#/my-work';
                      window.location.reload();
                    } catch {
                      /* leave the current session untouched */
                    }
                  }}
                >
                  {session.demoAccounts.map((a) => (
                    <option key={a.username} value={a.username}>
                      {a.displayName} — {roleLabel(a.role)}
                      {a.bureau ? ` (${a.bureau})` : ''}
                    </option>
                  ))}
                </select>
              </label>
            )}
            <div className="user-chip">
              <span className="avatar" aria-hidden="true">
                {user.displayName
                  .split(' ')
                  .map((p) => p[0])
                  .slice(0, 2)
                  .join('')}
              </span>
              <span className="user-meta">
                <span className="user-name">{user.displayName}</span>
                <span className="user-role">
                  {roleLabel(user.role)} · {user.bureau ?? 'Cross-bureau'}
                </span>
              </span>
            </div>
            <button
              type="button"
              className="btn btn-sm sign-out"
              aria-label="Sign out"
              onClick={async () => {
                await api.logout();
                sessionStorage.setItem(SIGNED_OUT_KEY, '1');
                await refreshSession();
                go('/login');
              }}
            >
              <Icon name="signout" size={18} /><span>Sign out</span>
            </button>
          </div>
        </header>

        <main className="content" id="main-content" tabIndex={-1}>
          <RouteView route={route} match={match} />
        </main>
      </div>
      {menuOpen && <Modal title="Navigation" drawer onClose={() => setMenuOpen(false)}>
        <Brand sub />
        {navigation}
        <ThemeControl />
        <button type="button" className="btn btn-ghost" onClick={() => { setMenuOpen(false); setHelp({}); }}><Icon name="help" size={18} />Help & privacy</button>
        <div className="small muted">{user.displayName} · {roleLabel(user.role)}</div>
        <div className="mobile-scope"><strong>{bureauName(user.bureau)}</strong><span>{user.region ? `${user.region} region` : 'National scope'} · Times shown in IST</span></div>
      </Modal>}
      {searchOpen && <SearchDialog onClose={() => setSearchOpen(false)} go={go} openHelp={topic => setHelp({ topic })} />}
      {help && <HelpDialog onClose={() => setHelp(null)} initialTopic={help.topic} />}
      <BackToTop route={pagePath} />
    </div>
  );
}

function Navigation({ activeNav, unread, overdue, onNavigate }: { activeNav: string; unread: number; overdue: number; onNavigate: () => void }) {
  return <nav className="nav" aria-label="Primary">
    {NAV.map((item) => <a key={item.id} href={`#/${item.id}`} onClick={onNavigate} className={classNames('nav-item', activeNav === item.id && 'nav-item-active')} aria-current={activeNav === item.id ? 'page' : undefined}>
      <Icon name={item.icon} /><span className="nav-label">{item.label}</span>
      {item.id === 'alerts' && unread > 0 && <span className="nav-count">{unread}</span>}
      {item.id === 'my-work' && overdue > 0 && <span className="nav-count">{overdue}</span>}
    </a>)}
    <div className="nav-section">Operations</div>
    {([{ id: 'import', label: 'CSV import', icon: 'upload' }, { id: 'settings', label: 'Settings', icon: 'settings' }] as const).map(item => <a key={item.id} href={`#/${item.id}`} onClick={onNavigate} className={classNames('nav-item', activeNav === item.id && 'nav-item-active')} aria-current={activeNav === item.id ? 'page' : undefined}><Icon name={item.icon} /><span className="nav-label">{item.label}</span></a>)}
  </nav>;
}

function titleFor(name: string): string {
  return (
    {
      'my-work': 'My work',
      institutions: 'Institutions',
      institution: 'Institution profile',
      cases: 'Cases',
      case: 'Case workspace',
      coordination: 'Coordination review',
      overlaps: 'Intelligent overlap detection',
      'coordination-focus': 'Coordination review',
      alerts: 'Alerts and notifications',
      reports: 'Reports',
      import: 'CSV import',
      settings: 'Settings and system status',
    }[name] ?? 'CaseLink'
  );
}

function useMyWorkCounts() {
  const { session } = useApp();
  const [counts, setCounts] = useState<{ overdue: number; unassigned: number }>({ overdue: 0, unassigned: 0 });
  useEffect(() => {
    let cancelled = false;
    api
      .myWork()
      .then((res) => {
        if (!cancelled) setCounts({ overdue: res.counts.overdue, unassigned: res.counts.unassigned });
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [session.user?.id]);
  return counts;
}

function NotificationPopover({
  notifications,
  onClose,
  onChanged,
  go,
}: {
  notifications: any[];
  onClose: () => void;
  onChanged: () => Promise<void>;
  go: (h: string) => void;
}) {
  return (
    <div
      className="card notification-popover"
      id="recent-notifications"
      role="dialog"
      aria-label="Recent notifications"
    >
      <div className="card-head">
        <h2 className="card-title">Recent notifications</h2>
        <button type="button" className="btn btn-ghost btn-sm" onClick={onClose}>
          Close
        </button>
      </div>
      <div className="card-body scroll-y" style={{ maxHeight: 340 }}>
        {notifications.length === 0 ? (
          <p className="muted small">No notifications yet. The scheduled check runs every 60 seconds.</p>
        ) : (
          <ul className="notif-list">
            {notifications.slice(0, 8).map((n) => (
              <li key={n.id}>
                <div className="notif-body">
                  <div className="notif-title">{n.title}</div>
                  <div className="notif-text">{n.body}</div>
                  <div className="notif-meta">
                    <span>{new Date(n.createdAt).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })} IST</span>
                    {!n.readAt && <Pill tone="blue">Unread</Pill>}
                  </div>
                </div>
                <button
                  type="button"
                  className="btn btn-ghost btn-sm"
                  onClick={async () => {
                    await api.markRead(n.id);
                    await onChanged();
                  }}
                >
                  Read
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
      <div className="card-foot">
        <a
          href="#/alerts"
          onClick={() => {
            go('/alerts');
            onClose();
          }}
        >
          Open alerts
        </a>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------- route views */

import LoginScreen from './screens/Login';
import MyWorkScreen from './screens/MyWork';
import { InstitutionsScreen, InstitutionDetailScreen } from './screens/Institutions';
import CasesScreen from './screens/Cases';
import CaseWorkspace from './screens/CaseWorkspace';
import CoordinationScreen from './screens/Coordination';
import OverlapDetectionScreen from './screens/OverlapDetection';
import AlertsScreen from './screens/Alerts';
import ReportsScreen from './screens/Reports';
import ImportScreen from './screens/Import';
import SettingsScreen from './screens/Settings';

function RouteView({ match }: { route: string; match: ReturnType<typeof matchRoute> }) {
  switch (match.name) {
    case 'my-work':
      return <MyWorkScreen />;
    case 'institutions':
      return <InstitutionsScreen />;
    case 'institution':
      return <InstitutionDetailScreen id={match.param!} />;
    case 'cases':
      return <CasesScreen initialQuery={match.query} />;
    case 'case':
      return <CaseWorkspace id={match.param!} />;
    case 'overlaps':
      return <OverlapDetectionScreen focus={match.param} />;
    case 'coordination':
    case 'coordination-focus':
      return <CoordinationScreen focus={match.param} />;
    case 'alerts':
      return <AlertsScreen />;
    case 'reports':
      return <ReportsScreen />;
    case 'import':
      return <ImportScreen />;
    case 'settings':
      return <SettingsScreen />;
    case 'login':
      return (
        <LoginScreen
          session={null}
          onSignedIn={async () => {
            window.location.hash = '#/my-work';
            window.location.reload();
          }}
          bootError={null}
        />
      );
    default:
      return <MyWorkScreen />;
  }
}
