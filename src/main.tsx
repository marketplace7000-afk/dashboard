import React from 'react';
import ReactDOM from 'react-dom/client';
import { App } from './App';
import './styles.css';
import { ErrorBoundary } from './components/ErrorBoundary';

// Общую память настроек (архив, параметры) App подтягивает уже ПОСЛЕ входа:
// раньше запрос уходил до входа и получал 401 (src/App.tsx).
ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <ErrorBoundary name="Кабинет">
      <App />
    </ErrorBoundary>
  </React.StrictMode>
);
