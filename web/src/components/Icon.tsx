import React from 'react';
import { SquaresFour } from '@phosphor-icons/react/dist/csr/SquaresFour';
import { Bank } from '@phosphor-icons/react/dist/csr/Bank';
import { Files } from '@phosphor-icons/react/dist/csr/Files';
import { GitFork } from '@phosphor-icons/react/dist/csr/GitFork';
import { Bell } from '@phosphor-icons/react/dist/csr/Bell';
import { ChartBar } from '@phosphor-icons/react/dist/csr/ChartBar';
import { UploadSimple } from '@phosphor-icons/react/dist/csr/UploadSimple';
import { GearSix } from '@phosphor-icons/react/dist/csr/GearSix';
import { LinkSimple } from '@phosphor-icons/react/dist/csr/LinkSimple';
import { ArrowRight } from '@phosphor-icons/react/dist/csr/ArrowRight';
import { Plus } from '@phosphor-icons/react/dist/csr/Plus';
import { ArrowClockwise } from '@phosphor-icons/react/dist/csr/ArrowClockwise';
import { Check } from '@phosphor-icons/react/dist/csr/Check';
import { LockKey } from '@phosphor-icons/react/dist/csr/LockKey';
import { List } from '@phosphor-icons/react/dist/csr/List';
import { X } from '@phosphor-icons/react/dist/csr/X';
import { SignOut } from '@phosphor-icons/react/dist/csr/SignOut';
import { Funnel } from '@phosphor-icons/react/dist/csr/Funnel';
import { CaretDown } from '@phosphor-icons/react/dist/csr/CaretDown';
import { Moon } from '@phosphor-icons/react/dist/csr/Moon';
import { Sun } from '@phosphor-icons/react/dist/csr/Sun';
import { Monitor } from '@phosphor-icons/react/dist/csr/Monitor';
import { MagnifyingGlass } from '@phosphor-icons/react/dist/csr/MagnifyingGlass';
import { Question } from '@phosphor-icons/react/dist/csr/Question';
import { ArrowUp } from '@phosphor-icons/react/dist/csr/ArrowUp';
import { Printer } from '@phosphor-icons/react/dist/csr/Printer';
import { Copy } from '@phosphor-icons/react/dist/csr/Copy';
import { Eye } from '@phosphor-icons/react/dist/csr/Eye';
import { EyeSlash } from '@phosphor-icons/react/dist/csr/EyeSlash';

const icons = {
  work: SquaresFour, institution: Bank, cases: Files, coordination: GitFork, bell: Bell,
  reports: ChartBar, upload: UploadSimple, settings: GearSix, link: LinkSimple, arrow: ArrowRight,
  plus: Plus, refresh: ArrowClockwise, check: Check, lock: LockKey, menu: List,
  close: X, signout: SignOut, filter: Funnel, chevron: CaretDown,
  moon: Moon, sun: Sun, monitor: Monitor, search: MagnifyingGlass, help: Question,
  up: ArrowUp, print: Printer, copy: Copy, eye: Eye, eyeOff: EyeSlash,
} as const;

export type IconName = keyof typeof icons;

export function Icon({ name, size = 20 }: { name: IconName; size?: number }) {
  const Glyph = icons[name];
  return <Glyph className="icon" data-icon={name} size={size} weight="regular" aria-hidden="true" focusable="false" />;
}

export function Brand({ sub = false }: { sub?: boolean }) {
  return <div className="brand">
    <span className="brand-mark" aria-hidden="true">
      <svg className="icon" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.8" strokeLinecap="round" strokeLinejoin="round"><path d="m10 13 4-4M8 16l-1 1a4.2 4.2 0 0 1-6-6l5-5a4.2 4.2 0 0 1 6 0m0 8a4.2 4.2 0 0 0 6 0l5-5a4.2 4.2 0 0 0-6-6l-1 1" /></svg>
    </span>
    <div><div className="brand-name">CaseLink</div>{sub && <div className="brand-sub">SIH26264 · AICTE</div>}</div>
  </div>;
}

