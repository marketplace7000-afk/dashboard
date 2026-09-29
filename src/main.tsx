import React from 'react';
import ReactDOM from 'react-dom/client';
import { App } from './App';
import './styles.css';
import { loadUiState, startUiStateSync } from './utils/uiState';

// Сначала подтягиваем общую память с сервера (архив, параметры), потом рендерим.
void loadUiState().finally(() => { startUiStateSync(); ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
); });
