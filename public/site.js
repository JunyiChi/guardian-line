/* Shared header (guardian shield, nav, language switcher) and footer for every page. */
(function () {
  const SHIELD = '<svg viewBox="0 0 48 54" aria-hidden="true"><defs><linearGradient id="sg" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#f1d77e"/><stop offset="1" stop-color="#b8901f"/></linearGradient></defs><path d="M24 2 L44 10 V25 C44 39 35 47 24 52 C13 47 4 39 4 25 V10 Z" fill="#0b1d3a" stroke="url(#sg)" stroke-width="3.5" stroke-linejoin="round"/><path d="M15 27 l6.5 6.5 L34 20" fill="none" stroke="url(#sg)" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/></svg>';
  const here = location.pathname.replace(/\.html$/, '').replace(/\/$/, '') || '/';
  const links = [['/', 'nav.home'], ['/try', 'nav.try'], ['/dashboard', 'nav.dashboard'], ['/setup', 'nav.setup'], ['/privacy', 'nav.privacy']];

  const header = document.getElementById('site-header');
  if (header) {
    const langs = Object.entries(window.i18n.langs);
    header.innerHTML = `
      <a class="brand" href="/">${SHIELD}<b>Wessuwan</b></a>
      <nav>${links.map(([href, key]) => `<a href="${href}"${here === href ? ' aria-current="page"' : ''} data-i18n="${key}"></a>`).join('')}</nav>
      <select class="lang" aria-label="Language">${langs.map(([code, name]) => `<option value="${code}"${code === window.i18n.lang ? ' selected' : ''}>${name}</option>`).join('')}</select>`;
    header.querySelector('.lang').onchange = (e) => window.i18n.setLang(e.target.value);
  }
  const footer = document.getElementById('site-footer');
  if (footer) footer.innerHTML = '<span data-i18n="footer.text"></span> · <a href="/privacy" data-i18n="footer.privacy"></a>';
  window.i18n.ready.then(() => window.i18n.apply(document));
})();
