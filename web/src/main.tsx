import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import '@/styles/global.scss';
import { BRAND_LOGO_URI, BRAND_NAME } from '@/assets/brandLogo';
import App from './App.tsx';

document.title = BRAND_NAME;
document.documentElement.setAttribute('translate', 'no');
document.documentElement.classList.add('notranslate');

const faviconEl = document.querySelector<HTMLLinkElement>('link[rel="icon"]');
if (faviconEl) {
  faviconEl.href = BRAND_LOGO_URI;
  faviconEl.type = 'image/svg+xml';
} else {
  const newFavicon = document.createElement('link');
  newFavicon.rel = 'icon';
  newFavicon.type = 'image/svg+xml';
  newFavicon.href = BRAND_LOGO_URI;
  document.head.appendChild(newFavicon);
}

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
