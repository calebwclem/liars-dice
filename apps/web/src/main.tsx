import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './ui/App.tsx';
import './ui/theme.css';

const root = document.getElementById('root');
if (root === null) throw new Error('no #root');
createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
