import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { api, type M2Candidate, type M2Detail, type M2Queue } from '../api';
import { useSharedRefresh } from '../refresh';
import { Card, ErrorNote, Loading, Pill } from '../ui';
import './OverlapDetection.css';

type View = 'queue' | 'matches' | 'explanation' | 'handoff';
type QueueFilter = 'open' | 'all' | 'outdated' | 'accepted';
type SortBy = 'signals' | 'recent' | 'wording';

const formatDate = (date: string) => new Date(date).toLocaleDateString('en-IN', {
  day: 'numeric', month: 'short', year: 'numeric', timeZone: 'Asia/Kolkata',
});
const name = (c: M2Candidate['caseA']) => c.caseNumber || 'Case reference unavailable';
const factors: Record<string, { title: string; description: string }> = {
  shared_external_reference: { title: 'Common reference', description: 'An identical external reference is listed in both complaints.' },
  reviewed_institution_alias: { title: 'Institution context', description: 'Both complaints mention a reviewed institution alias.' },
  incident_period_overlap: { title: 'Relevant dates', description: 'Reports fall within the matching engine’s 14-day window.' },
  same_category: { title: 'Issue category', description: 'The complaints use the same issue classification.' },
  different_category: { title: 'Different issue categories', description: 'A reason to be cautious about treating the cases as related.' },
  topic_similarity: { title: 'Complaint wording', description: 'Token overlap was calculated by the existing rule-based engine.' },
};
const excerpt = (s: string | null) => s ?? 'Restricted — request a case-content grant to see this complaint.';

function Signal({ candidate }: { candidate: M2Candidate }) {
  return <div className="m2-signal">
    <b>{candidate.evidenceSignals}</b> <span>evidence signals</span>
    {candidate.lexicalJaccard !== null && <small>{candidate.lexicalJaccard.toFixed(2)} wording Jaccard</small>}
  </div>;
}
function CandidateCase({ item, title }: { item: M2Candidate['caseA']; title: string }) {
  return <Card className="m2-casecard">
    <div className="m2-eyebrow">{title}</div>
    <div className="m2-caseid">{name(item)}</div>
    <div className="m2-sub">{item.institutionName} · {item.bureau}</div>
    <div className="m2-preview">
      <b>Read-only complaint preview</b>
      <p>{excerpt(item.summary)}</p>
      {item.access === 'restricted' && <span className="m2-restricted">🔒 Restricted case text</span>}
    </div>
    <dl className="m2-fields">
      <div><dt>Institution ID</dt><dd>{item.institutionPermanentId || 'Not available'}</dd></div>
      <div><dt>Category</dt><dd>{item.category}</dd></div>
      <div><dt>Status</dt><dd>{item.status}</dd></div>
      <div><dt>Case version</dt><dd>v{item.version}</dd></div>
    </dl>
  </Card>;
}
export default function OverlapDetectionScreen({ focus }: { focus?: string }) {
  const [view, setView] = useState<View>('queue');
  const [queue, setQueue] = useState<M2Queue | null>(null);
  const [detail, setDetail] = useState<M2Detail | null>(null);
  const [siblings, setSiblings] = useState<M2Candidate[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [focusCaseId, setFocusCaseId] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [query, setQuery] = useState('');
  const [state, setState] = useState<QueueFilter>('open');
  const [category, setCategory] = useState('');
  const [sort, setSort] = useState<SortBy>('signals');
  const [page, setPage] = useState(1);
  const [error, setError] = useState<Error | null>(null);
  const [busy, setBusy] = useState(false);
  const [supervisorId, setSupervisorId] = useState('');
  const [reason, setReason] = useState('');
  const [success, setSuccess] = useState(false);

  useEffect(() => { const id = window.setTimeout(() => { setQuery(search); setPage(1); }, 250); return () => clearTimeout(id); }, [search]);
  const refreshQueue = useCallback(async () => {
    const params = new URLSearchParams({ page: String(page), pageSize: '10', state, sort });
    if (query) params.set('search', query);
    if (category) params.set('category', category);
    const response = await api.m2Queue(params);
    setQueue(response);
    setError(null);
  }, [page, state, sort, query, category]);
  useEffect(() => {
    let mounted = true;
    refreshQueue().catch((e: Error) => { if (mounted) setError(e); });
    return () => { mounted = false; };
  }, [refreshQueue]);
  useSharedRefresh(refreshQueue);

  const openCandidate = useCallback(async (id: string, preserveFocus = false) => {
    setBusy(true); setError(null);
    try {
      const result = await api.m2Detail(id);
      const caseId = preserveFocus && focusCaseId ? focusCaseId : result.candidate.caseA.id;
      const list = await api.m2Queue(new URLSearchParams({ state: 'all', page: '1', pageSize: '50', caseId, sort: 'signals' }));
      setSelectedId(id);
      setFocusCaseId(caseId);
      setDetail(result);
      setSiblings(list.rows);
      setSupervisorId(result.supervisors[0]?.id ?? '');
      setReason('');
      setSuccess(false);
      setView('matches');
    } catch (e) { setError(e as Error); }
    finally { setBusy(false); }
  }, [focusCaseId]);

  useEffect(() => { if (focus) void openCandidate(focus); }, [focus]);

  const selected = detail?.candidate ?? null;
  const otherMatches = useMemo(() => siblings.filter((s) => s.id !== selectedId), [siblings, selectedId]);
  const canHandoff = Boolean(selected && !selected.requiresContentAccess &&
    selected.state === 'open' && detail?.supervisors.length);
  const send = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!selected || !canHandoff || busy) return;
    setBusy(true); setError(null);
    try {
      await api.m2Handoff(selected.id, supervisorId, reason.trim(), selected.caseA.version, selected.caseB.version);
      setSuccess(true);
      setReason('');
      await refreshQueue();
      const updated = await api.m2Detail(selected.id);
      setDetail(updated);
    } catch (e) { setError(e as Error); }
    finally { setBusy(false); }
  };
  const goBack = () => { setError(null); setView(view === 'handoff' ? 'explanation' : view === 'explanation' ? 'matches' : 'queue'); };

  return <div className="m2">
    <div className="m2-head">
      <div>
        <div className="m2-eyebrow">M2 / CASELINK OPERATIONS</div>
        <h1>Intelligent overlap detection</h1>
        <p>Find potential relationships, inspect the underlying evidence, then request supervisor review.</p>
      </div>
      <span className="m2-mode">Rule-based · {queue?.ruleVersion ?? 'checking'}</span>
    </div>
    <div className="m2-steps" aria-label="Module steps">
      {(['queue', 'matches', 'explanation', 'handoff'] as View[]).map((step, index) =>
        <button key={step} type="button" className={view === step ? 'm2-step selected' : 'm2-step'}
          disabled={step !== 'queue' && !selected} onClick={() => setView(step)}>
          <span>{String(index + 1).padStart(2, '0')}</span>
          {['Detection dashboard', 'Matched complaints', 'Why they match', 'Supervisor handoff'][index]}
        </button>)}
    </div>
    {error && <div className="m2-error" role="alert">{error.message} <button type="button" onClick={() => { setError(null); void refreshQueue(); }}>Retry</button></div>}
    {queue?.matchingMode === 'unavailable' && <div className="m2-warning">Matching is currently paused. Existing results may be outdated.</div>}
    {view === 'queue' && <>
      <div className="m2-metrics">
        <div><b>{queue?.counts.visibleCandidates ?? '—'}</b><span>Visible candidates</span></div>
        <div><b>{queue?.counts.awaitingReview ?? '—'}</b><span>Open suggestions</span></div>
        <div><b>{queue?.counts.sentForReview ?? '—'}</b><span>Sent for review</span></div>
        <div><b>{queue?.total ?? '—'}</b><span>Filtered results</span></div>
      </div>
      <Card className="m2-tablecard">
        <div className="m2-toolbar">
          <div className="m2-tabs">
            {(['open','all','outdated','accepted'] as QueueFilter[]).map((s) =>
              <button type="button" key={s} className={state === s ? 'active' : ''} onClick={() => { setState(s); setPage(1); }}>
                {s === 'open' ? 'Needs review' : s === 'all' ? 'All candidates' : s === 'outdated' ? 'Outdated' : 'Previously decided'}
              </button>)}
          </div>
          <div className="m2-controls">
            <label>Search complaints<input aria-label="Search complaints" value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Case ID, institution, issue…" /></label>
            <label>Category<select aria-label="Category" value={category} onChange={(e) => { setCategory(e.target.value); setPage(1); }}>
              <option value="">All categories</option>
              {queue?.categoryOptions.map((c) => <option key={c} value={c}>{c}</option>)}
            </select></label>
            <label>Rank by<select aria-label="Rank by" value={sort} onChange={(e) => setSort(e.target.value as SortBy)}>
              <option value="signals">Evidence signals</option>
              <option value="wording">Word overlap</option>
              <option value="recent">Most recent</option>
            </select></label>
          </div>
        </div>
        {!queue ? <Loading label="Loading authorized matching results…" /> :
        queue.rows.length === 0 ? <div className="m2-empty">No candidates in your authorized scope match these filters.</div> :
        <div className="m2-tablewrap"><table className="m2-table">
          <thead><tr><th>Primary complaint</th><th>Potential match</th><th>Institution</th><th>Evidence ranking</th><th>Review status</th><th>Action</th></tr></thead>
          <tbody>{queue.rows.map((s) => <tr key={s.id}>
            <td><b>{name(s.caseA)}</b><small>{s.caseA.category}</small></td>
            <td><b>{name(s.caseB)}</b><small>{s.caseB.category}</small></td>
            <td><span>{s.caseA.institutionName}</span><small>{s.caseA.institutionPermanentId}</small></td>
            <td><Signal candidate={s} /></td>
            <td><Pill tone={s.handoffCount ? 'blue' : s.state === 'open' ? 'amber' : 'slate'}>{s.state === 'accepted' ? 'Relationship confirmed' : s.state === 'outdated' ? 'Outdated' : s.handoffCount ? 'Sent for review' : s.state === 'open' ? 'New suggestion' : s.state}</Pill></td>
            <td><button className="m2-action" disabled={busy} onClick={() => void openCandidate(s.id)}>Inspect →</button></td>
          </tr>)}</tbody>
        </table></div>}
        <div className="m2-pagination">
          <span>Page {queue?.page ?? 1} of {Math.max(1, queue?.pages ?? 1)} · {queue?.total ?? 0} authorized results</span>
          <div><button type="button" disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>Previous</button>
          <button type="button" disabled={!queue || page >= queue.pages} onClick={() => setPage((p) => p + 1)}>Next</button></div>
        </div>
      </Card>
      <p className="m2-footnote">Ranked by independently stored evidence signals and measured token overlap. A match is a candidate, not a duplicate decision. No accuracy claim is made.</p>
    </>}
    {view === 'matches' && selected && <>
      <button className="m2-back" onClick={goBack}>← All candidate matches</button>
      <div className="m2-sectionhead"><div><h2>Matched complaint details</h2><p>Open the evidence without altering either original complaint.</p></div><Signal candidate={selected} /></div>
      <div className="m2-grid"><CandidateCase title="COMPLAINT A" item={selected.caseA} /><CandidateCase title="COMPLAINT B" item={selected.caseB} /></div>
      <Card className="m2-matchsection">
        <div className="m2-sectionhead"><div><h3>Other ranked matches for {focusCaseId === selected.caseA.id ? name(selected.caseA) : name(selected.caseB)}</h3><p>Each suggestion is a separate pair; no transitive matching is assumed.</p></div><Pill tone="indigo">{otherMatches.length} other on this page</Pill></div>
        {otherMatches.length ? otherMatches.map((s) => <div className="m2-matchline" key={s.id}>
          <div><b>{name(s.caseA)} ↔ {name(s.caseB)}</b><small>{s.kind} · {s.evidenceSignals} independent evidence signals</small></div>
          <button className="m2-action" type="button" onClick={() => void openCandidate(s.id, true)}>Compare →</button>
        </div>) : <p className="m2-muted">No additional authorized pairs on the first 50 ranked results.</p>}
        <div className="m2-footer"><button className="m2-primary" onClick={() => setView('explanation')}>Explain this match →</button></div>
      </Card>
    </>}
    {view === 'explanation' && selected && <>
      <button className="m2-back" onClick={goBack}>← Matched complaints</button>
      <div className="m2-sectionhead"><div><h2>Why were these complaints matched?</h2><p>Source-backed signals for {name(selected.caseA)} and {name(selected.caseB)}.</p></div><Signal candidate={selected} /></div>
      <div className="m2-explain-grid">
        <Card className="m2-explaincard">
          <h3>Calculation and evidence</h3>
          <p className="m2-muted">These factors come from the existing deterministic matching engine, not generated confidence percentages.</p>
          {selected.reasons.map((r, i) => <div className="m2-factor" key={r.rule + i}>
            <span className="m2-factoricon">{r.rule === 'different_category' ? '!' : '✓'}</span>
            <div><b>{factors[r.rule]?.title ?? r.rule.replaceAll('_',' ')}</b>
              <p>{r.detail || factors[r.rule]?.description}</p><small>Source: {r.sourceField}</small>
            </div>
          </div>)}
          {selected.lexicalJaccard !== null && <div className="m2-measure">
            <div><b>Calculated lexical Jaccard</b><strong>{selected.lexicalJaccard.toFixed(2)} / 1.00</strong></div>
            <div className="m2-track"><span style={{ width: String(selected.lexicalJaccard * 100) + '%' }} /></div>
            <small>Measured token-set intersection / union from the matching rule; this is not a probability.</small>
          </div>}
        </Card>
        <Card className="m2-explaincard">
          <h3>Interpretation and limits</h3>
          <div className="m2-limit"><b>Institution identity</b><p>Both records must share the same resolved canonical institution ID to qualify.</p></div>
          <div className="m2-limit"><b>Issue category</b><p>Equal or different categories appear in the evidence; identical categories alone do not establish duplication.</p></div>
          <div className="m2-limit"><b>Incident timing</b><p>A 14-day rule window is a supporting signal, not proof of one incident.</p></div>
          <div className="m2-limit"><b>Semantic embedding similarity</b><p>Not available in this implementation. The engine uses deterministic wording overlap, not an embedding model.</p></div>
          {selected.reasonsRedacted && <div className="m2-warning">Detailed wording and calculated lexical similarity are withheld because your account lacks content access to both complaints.</div>}
          <div className="m2-warning">A relationship decision and any linking belong to M4. This module can only request supervisor review.</div>
          <div className="m2-footer">
            <button className="m2-primary" disabled={!canHandoff} onClick={() => setView('handoff')}>Send for supervisor review →</button>
            {!canHandoff && <small>Requires both-case content access, an open candidate, and an authorized supervisor.</small>}
          </div>
        </Card>
      </div>
    </>}
    {view === 'handoff' && selected && <>
      <button className="m2-back" onClick={goBack}>← Matching explanation</button>
      <div className="m2-sectionhead"><div><h2>Supervisor review handoff</h2><p>Submit the evidence for human review. No complaints are merged, linked, assigned or resolved here.</p></div><Pill tone="amber">Awaiting supervisor</Pill></div>
      <div className="m2-handoff-grid">
        <Card className="m2-explaincard">
          <h3>Review package</h3>
          <div className="m2-matchline"><div><b>{name(selected.caseA)}</b><small>{selected.caseA.category}</small></div><Pill tone="slate">Original preserved</Pill></div>
          <div className="m2-matchline"><div><b>{name(selected.caseB)}</b><small>{selected.caseB.category}</small></div><Pill tone="slate">Original preserved</Pill></div>
          <div className="m2-limit"><b>Matching evidence</b><p>{selected.evidenceSignals} rule-derived evidence signals · version {selected.ruleVersion}.</p></div>
          <div className="m2-warning">Supervisor access to complaint content remains subject to separate case authorization.</div>
        </Card>
        <Card className="m2-explaincard">
          {success ? <div role="status"><h3>Sent for supervisor review</h3><p>The handoff has been recorded and the supervisor notified. Case ownership and relationship records remain unchanged.</p>
            <button type="button" className="m2-primary" onClick={() => setView('queue')}>Return to detection dashboard</button></div> :
          <form onSubmit={(e) => void send(e)}>
            <h3>Send a review request</h3>
            <label className="m2-formlabel">Authorized supervisor<select value={supervisorId} disabled={!canHandoff || busy}
              onChange={(e) => setSupervisorId(e.target.value)} required>
                <option value="">Choose supervisor</option>{detail?.supervisors.map((s) => <option key={s.id} value={s.id}>{s.displayName}</option>)}
              </select></label>
            <label className="m2-formlabel">Reason for requesting review<textarea value={reason} onChange={(e) => setReason(e.target.value)}
              minLength={10} maxLength={800} required disabled={!canHandoff || busy} placeholder="Explain what evidence needs human verification." /></label>
            <div className="m2-footer"><button className="m2-primary" type="submit" disabled={!canHandoff || !supervisorId || reason.trim().length < 10 || busy}>
              {busy ? 'Sending…' : 'Send for supervisor review'}
            </button></div>
          </form>}
        </Card>
      </div>
    </>}
  </div>;
}
