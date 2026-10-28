// Shared by the real panel and options page. No remote font or theme requests.
const systemTheme = matchMedia('(prefers-color-scheme: dark)');
let appearance = 'system';

function applyTheme() {
  document.documentElement.classList.toggle(
    'dark',
    appearance === 'dark' || (appearance === 'system' && systemTheme.matches),
  );
}

applyTheme();
systemTheme.addEventListener('change', applyTheme);
chrome.storage.local.get('appearance').then((settings) => {
  appearance = ['light', 'dark'].includes(settings.appearance) ? settings.appearance : 'system';
  applyTheme();
}).catch(() => {});
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local' || !changes.appearance) return;
  appearance = ['light', 'dark'].includes(changes.appearance.newValue)
    ? changes.appearance.newValue : 'system';
  applyTheme();
});
