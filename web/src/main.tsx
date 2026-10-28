import React from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import './styles.css';
import { ThemeProvider } from './theme';

const container = document.getElementById('root');
if (!container) throw new Error('root element missing');
createRoot(container).render(
  <React.StrictMode>
    <ThemeProvider><App /></ThemeProvider>
  </React.StrictMode>
);
