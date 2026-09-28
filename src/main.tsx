import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import './styles/app.css';
import './styles/places.css';
import './styles/narrative-map.css';
import './styles/paper.css';
import '../public/world-effects.js';
import '../public/world-effects.css';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
