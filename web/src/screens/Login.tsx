import React, { useState } from 'react';
import { api, ApiError, type SessionInfo } from '../api';
import { Card, ErrorNote, Field, Notice } from '../ui';
import { roleLabel } from '../util';
import { Brand, Icon } from '../components/Icon';
import { ThemeControl } from '../theme';
import { HelpDialog } from '../components/HelpDialog';

/** Used only when the session endpoint is unreachable; mirrors the seeded demo accounts. */
const FALLBACK_ACCOUNTS = [
  { username: 'm.nair', displayName: 'Meera Nair', role: 'bureau_lead', bureau: 'PGRC', password: 'caselink-demo' },
  { username: 'l.verma', displayName: 'Lalit Verma', role: 'bureau_lead', bureau: 'RB', password: 'caselink-demo' },
  { username: 'p.rao', displayName: 'Priya Rao', role: 'bureau_officer', bureau: 'PGRC', password: 'caselink-demo' },
  { username: 's.iyer', displayName: 'Suresh Iyer', role: 'bureau_officer', bureau: 'RB', password: 'caselink-demo' },
  { username: 'a.desai', displayName: 'Ananya Desai', role: 'supervisor', bureau: null, password: 'caselink-demo' },
  { username: 'r.khan', displayName: 'Rekha Khan', role: 'reviewer', bureau: null, password: 'caselink-demo' },
];

export default function LoginScreen({
  session,
  onSignedIn,
  bootError,
  onDirectEntry,
}: {
  session: SessionInfo | null;
  onSignedIn: () => Promise<void>;
  bootError: ApiError | null;
  onDirectEntry?: (username: string) => Promise<void>;
}) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<ApiError | null>(null);
  const [busy, setBusy] = useState(false);
  const [showPassword, setShowPassword] = useState(false);
  const [helpOpen, setHelpOpen] = useState(false);
  // Demo accounts, shortcuts and the direct-entry button exist only when the server reports demo mode.
  const demoMode = session?.demoMode === true;
  const accounts = demoMode ? session?.demoAccounts ?? FALLBACK_ACCOUNTS : [];
  const [directBusy, setDirectBusy] = useState<string | null>(null);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setShowPassword(false);
    setBusy(true);
    setError(null);
    try {
      await api.login(username, password);
      await onSignedIn();
    } catch (err) {
      setError(err as ApiError);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="login-wrap">
      <a className="skip-link" href="#username" onClick={event => { event.preventDefault(); document.getElementById('username')?.focus(); }}>Skip to sign in</a>
      <header className="login-header">
        <Brand />
        <div className="login-header-controls"><span className="demo-badge">Demo environment</span><ThemeControl compact /></div>
      </header>
      <main className="login-main">
      <div className="login-art">
        <h1>
          One view.
          <br />
          Clear action.
        </h1>
        <p>
          Coordinate institution complaints across bureaus, with clear ownership, next actions and a complete case history.
        </p>
        <details className="login-about"><summary>How coordination works <Icon name="chevron" size={14} /></summary><p>
          CaseLink joins Regulation Bureau and Public Grievance Redressal Cell records around a canonical institution, keeps each
          complaint's own owner, deadlines and outcome, and makes cross-bureau overlap visible without exposing restricted complaint text.
        </p></details>
        <ul className="login-features">
          <li><Icon name="lock" />Access scoped to your role, bureau and region.</li>
          <li><Icon name="coordination" />Cross-bureau overlap, with human-confirmed links.</li>
          <li><Icon name="cases" />Every action recorded. Every case accountable.</li>
        </ul>
      </div>

      <div className="login-panel">
        <div className="login-card">
          <Card
            title="Sign in"
            subtitle="Welcome back. Sign in to your CaseLink workspace."
          >
            {onDirectEntry && demoMode && (
              <div className="stack-sm" style={{ marginBottom: 14 }}>
                <button
                  type="button"
                  className="btn btn-accent btn-block"
                  disabled={directBusy !== null}
                  onClick={async () => {
                    setDirectBusy('m.nair');
                    try {
                      await onDirectEntry(localStorage.getItem('caselink.demoUser') ?? 'm.nair');
                    } finally {
                      setDirectBusy(null);
                    }
                  }}
                >
                  {directBusy ? 'Opening workspace…' : 'Enter the demo workspace directly (bureau lead)'}
                </button>
                <p className="small muted">
                  Opens My work without a password. You can switch accounts from the header at any time.
                </p>
                <div className="divider" />
                <p className="small muted">Or sign in with a named account:</p>
              </div>
            )}
            <form className="stack" onSubmit={submit}>
              {bootError && <ErrorNote error={bootError} />}
              <Field label="Username" htmlFor="username" required>
                <input
                  id="username"
                  name="username"
                  autoComplete="username"
                  value={username}
                  onChange={(e) => setUsername(e.target.value)}
                  required
                />
              </Field>
              <Field
                label="Password"
                htmlFor="password"
                required
                hint={demoMode ? 'Demo password for every synthetic account: caselink-demo' : 'Contact your system administrator if you need access.'}
              >
                <div className="password-input"><input
                  id="password"
                  name="password"
                  type={showPassword ? 'text' : 'password'}
                  autoComplete="current-password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  required
                /><button type="button" className="btn btn-ghost btn-icon password-toggle" aria-label={showPassword ? 'Hide password' : 'Show password'} aria-pressed={showPassword} aria-controls="password" onClick={() => setShowPassword(value => !value)}><Icon name={showPassword ? 'eyeOff' : 'eye'} size={18} /></button></div>
              </Field>
              <ErrorNote error={error} />
              <button type="submit" className="btn btn-primary btn-block" disabled={busy}>
                {busy ? 'Signing in…' : 'Sign in'}
                <Icon name="arrow" size={18} />
              </button>
              <p className="login-security"><Icon name="lock" size={15} />Your account determines your role and access.</p>
            </form>
          </Card>

          {demoMode && (
          <Card title="Demo accounts" subtitle="Click an account to fill the form. Each one demonstrates a different scope.">
            <div className="demo-accounts">
              {accounts.map((a) => (
                <button
                  key={a.username}
                  type="button"
                  className="demo-account"
                  onClick={async () => {
                    setUsername(a.username);
                    setPassword(a.password);
                    setError(null);
                    if (onDirectEntry) {
                      setDirectBusy(a.username);
                      try {
                        await onDirectEntry(a.username);
                      } finally {
                        setDirectBusy(null);
                      }
                    }
                  }}
                >
                  <span>
                    <span className="who">
                      {a.displayName} · {a.username}
                    </span>
                    <br />
                    <span className="role">
                      {roleLabel(a.role)}
                      {a.bureau ? ` · ${a.bureau}` : ' · cross-bureau'}
                    </span>
                  </span>
                  <span className="pill pill-slate">{onDirectEntry ? 'enter' : 'use'}</span>
                </button>
              ))}
            </div>
          </Card>
          )}

          <Notice tone="warn">
            <strong>Prototype notice</strong>
            {demoMode
              ? 'Demo mode is active: fixture entry and synthetic accounts are enabled. All records are fictional.'
              : 'Sign-in is required. All records in this environment are fictional fixtures; no official SLA applies.'}
          </Notice>
        </div>
      </div>
      </main>
      <footer className="login-footer"><span>Institution complaint coordination · SIH26264</span><button type="button" className="btn btn-ghost btn-sm" onClick={() => setHelpOpen(true)}>Help & privacy</button><span>Synthetic records only · Times shown in IST</span></footer>
      {helpOpen && <HelpDialog initialTopic="privacy" onClose={() => setHelpOpen(false)} />}
    </div>
  );
}
