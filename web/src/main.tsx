import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import '@/styles/global.scss';
import '@/i18n';
import { BRAND_NAME } from '@/assets/brandLogo';
import App from './App.tsx';

document.title = BRAND_NAME;
document.documentElement.setAttribute('translate', 'no');
document.documentElement.classList.add('notranslate');

// The favicon (the tile icon) is inlined in index.html.

const render = () =>
  createRoot(document.getElementById('root')!).render(
    <StrictMode>
      <App />
    </StrictMode>
  );

// DEV-only fixture session (`/?fixture=quota-history#/quota`): statically false in
// production builds, so the fixture module is dropped from the single-file bundle.
if (import.meta.env.DEV && new URLSearchParams(window.location.search).has('fixture')) {
  void import('@/features/quota/__fixtures__/devFixture')
    .then(({ installQuotaHistoryFixture, isFixtureRequested }) => {
      if (isFixtureRequested()) installQuotaHistoryFixture();
    })
    .finally(render);
} else {
  render();
}
