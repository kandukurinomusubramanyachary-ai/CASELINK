import React, { useEffect, useState } from 'react';
import { Icon } from './Icon';

export function BackToTop({ route }: { route: string }) {
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    let frame = 0;
    const update = () => { frame = 0; setVisible((window.scrollY > Math.max(480, innerHeight * .75) && document.documentElement.scrollHeight > innerHeight * 1.75) || [...document.querySelectorAll<HTMLElement>('main .table-wrap, main .scroll-y')].some(element => element.scrollTop > 480 && element.scrollHeight > element.clientHeight * 1.75)); };
    const scroll = () => { if (!frame) frame = requestAnimationFrame(update); };
    window.addEventListener('scroll', scroll, { passive: true });
    document.addEventListener('scroll', scroll, { passive: true, capture: true });
    update();
    return () => { window.removeEventListener('scroll', scroll); document.removeEventListener('scroll', scroll, true); cancelAnimationFrame(frame); };
  }, [route]);
  if (!visible) return null;
  return <button type="button" className="btn btn-icon back-to-top" aria-label="Back to top" onClick={() => {
    document.getElementById('main-content')?.focus({ preventScroll: true });
    const behavior = matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth';
    window.scrollTo({ top: 0, behavior });
    document.querySelectorAll('main .table-wrap, main .scroll-y').forEach(element => element.scrollTo({ top: 0, behavior }));
  }}><Icon name="up" /></button>;
}
