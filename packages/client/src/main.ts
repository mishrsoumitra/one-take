// grauity, Newton School's design system: the design tokens (light and dark) and the icon font.
import '@newtonschool/grauity/tokens.css';
import '@newtonschool/grauity/css/grauity-icons.scss';
// One Take on top of it: the brand font and token aliases, the component recipes, the page layout.
import './styles/theme.css';
import './styles/grauity.css';
import './styles/app.css';
import './styles/checks.css';

import { App } from './app/app.js';
import { installFavicon } from './ui/icon.js';

declare global {
  interface Window {
    __onetake?: Record<string, unknown>;
  }
}

const root = document.getElementById('app');
if (!root) throw new Error('Missing #app root element');

installFavicon();
const app = new App(root);
window.__onetake = app.testHooks();
void app.init();
