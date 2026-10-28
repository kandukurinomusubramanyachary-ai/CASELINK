import React from 'react';
import { HELP } from '../help';
import { Modal } from '../ui';

export function HelpDialog({ onClose, initialTopic }: { onClose: () => void; initialTopic?: string }) {
  return <Modal title="CaseLink help" onClose={onClose} wide>
    <p className="muted">Practical guidance for this institution complaint coordination prototype.</p>
    <div className="help-topics">{HELP.map(item => <details key={item.id} open={initialTopic === item.id || undefined}>
      <summary>{item.title}</summary><p>{item.text}</p>
    </details>)}</div>
  </Modal>;
}
