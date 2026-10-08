import './styles/app.css';

import { App } from './app/app.js';

declare global {
  interface Window {
    __onetake?: Record<string, unknown>;
  }
}

const root = document.getElementById('app');
if (!root) throw new Error('Missing #app root element');

const app = new App(root);
window.__onetake = app.testHooks();
void app.init();
