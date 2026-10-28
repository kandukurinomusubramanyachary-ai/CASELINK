import React, { useEffect, useRef, useState } from 'react';
import { api, ApiError } from '../api';
import { ErrorNote, Loading, Modal } from '../ui';
import { searchHelp } from '../help';
import { Icon } from './Icon';
import { fmtDateTime } from '../util';

type Result = { id: string; kind: string; title: string; detail: string; url?: string; topic?: string; at?: string };

export function SearchDialog({ onClose, go, openHelp }: { onClose: () => void; go: (url: string) => void; openHelp: (topic: string) => void }) {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<Result[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  const [selected, setSelected] = useState(0);
  const [more, setMore] = useState(false);
  const [retry, setRetry] = useState(0);
  const list = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const needle = query.trim();
    if (needle.length < 2) { setResults([]); setLoading(false); setError(null); return; }
    const controller = new AbortController();
    setLoading(true); setError(null); setSelected(0); setResults([]);
    const timer = setTimeout(async () => {
      const help = searchHelp(needle).slice(0, 5).map(item => ({ id: item.id, kind: 'help', title: item.title, detail: item.text, topic: item.id }));
      try {
        const response = await api.search(needle, controller.signal);
        if (controller.signal.aborted) return;
        setResults([...response.results, ...help]); setMore(response.more);
      } catch (reason) {
        if (controller.signal.aborted) return;
        setError(reason as ApiError); setResults(help);
      } finally { if (!controller.signal.aborted) setLoading(false); }
    }, 250);
    return () => { clearTimeout(timer); controller.abort(); };
  }, [query, retry]);
  const choose = (result: Result) => { onClose(); if (result.topic) openHelp(result.topic); else if (result.url) go(result.url); };
  return <Modal title="Search CaseLink" onClose={onClose} wide>
    <label className="field" htmlFor="global-search"><span className="field-label">Cases, authorized action history and help</span>
      <input id="global-search" role="combobox" autoComplete="off" aria-autocomplete="list" aria-controls="search-results" aria-expanded={results.length > 0} aria-activedescendant={results[selected] ? `search-option-${selected}` : undefined} placeholder="Case number, event ID, staff name, decision reason…" value={query} maxLength={200} onChange={event => setQuery(event.target.value)} onKeyDown={event => {
        if ((event.key === 'ArrowDown' || event.key === 'ArrowUp') && results.length) {
          event.preventDefault(); const next = (selected + (event.key === 'ArrowDown' ? 1 : -1) + results.length) % results.length; setSelected(next);
          list.current?.querySelector(`#search-option-${next}`)?.scrollIntoView({ block: 'nearest' });
        } else if (event.key === 'Enter' && results[selected]) { event.preventDefault(); choose(results[selected]); }
      }} />
    </label>
    {loading && <Loading label="Searching records you can access…" rows={3} />}
    <ErrorNote error={error} onRetry={() => setRetry(value => value + 1)} />
    <div role="status" className="small muted">{query.trim().length < 2 ? 'Enter at least two characters. Use arrow keys and Enter to open a result.' : !loading && !error ? `${results.length} result${results.length === 1 ? '' : 's'}${more ? ' shown; narrow your search for more specific matches' : ''}.` : ''}</div>
    <div id="search-results" role="listbox" aria-label="Search results" className="search-results" aria-busy={loading} ref={list}>
      {results.map((result, index) => <button key={`${result.kind}-${result.id}`} id={`search-option-${index}`} type="button" role="option" aria-selected={selected === index} className="search-result" onMouseDown={event => event.preventDefault()} onClick={() => choose(result)}>
        <Icon name={result.kind === 'help' ? 'help' : result.kind === 'history' ? 'reports' : 'cases'} size={18} />
        <span><strong>{result.title}</strong><span className="search-result-detail">{result.detail}</span>{result.at && <span className="small muted">Recorded {fmtDateTime(result.at)}</span>}</span>
      </button>)}
    </div>
    {query.trim().length >= 2 && !loading && !error && results.length === 0 && <p className="notice notice-info">No matching accessible records or help topics. Try a shorter case number or a different term.</p>}
  </Modal>;
}
