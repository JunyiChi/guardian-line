/* Shared header (floating navbar with the guardian shield, links, language switcher) and footer for every public page. */
(function () {
  const SHIELD = '<svg viewBox="0 0 48 54" aria-hidden="true"><defs><linearGradient id="sg" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#f1d77e"/><stop offset="1" stop-color="#b8901f"/></linearGradient></defs><path d="M24 2 L44 10 V25 C44 39 35 47 24 52 C13 47 4 39 4 25 V10 Z" fill="#0b1d3a" stroke="url(#sg)" stroke-width="3.5" stroke-linejoin="round"/><path d="M15 27 l6.5 6.5 L34 20" fill="none" stroke="url(#sg)" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/></svg>';
  const GITHUB = 'https://github.com/chenjunmingk-source/Wessuwan';
  const here = location.pathname.replace(/\.html$/, '').replace(/\/$/, '') || '/';
  const links = [['/try', 'nav.try'], ['/dashboard', 'nav.demo'], ['/#how', 'nav.how'], ['/privacy', 'nav.privacy'], [GITHUB, 'nav.github']];
  const link = ([href, key]) => {
    const ext = href.startsWith('http');
    return `<a href="${href}"${here === href ? ' aria-current="page"' : ''}${ext ? ' target="_blank" rel="noopener" data-github' : ''} data-i18n="${key}"></a>`;
  };

  const header = document.getElementById('site-header');
  if (header) {
    const langs = Object.entries(window.i18n.langs);
    header.innerHTML = `
      <div class="nav-pill">
        <a class="brand" href="/">${SHIELD}<b>Wessuwan</b></a>
        <nav aria-label="Main">${links.map(link).join('')}</nav>
        <div class="nav-end">
          ${langs.length > 1 ? `<select class="lang" aria-label="Language">${langs.map(([code, name]) => `<option value="${code}"${code === window.i18n.lang ? ' selected' : ''}>${name}</option>`).join('')}</select>` : ''}
          <a class="nav-cta" href="/try" data-i18n="nav.tryNow"></a>
        </div>
      </div>`;
    header.querySelector('.lang')?.addEventListener('change', (e) => window.i18n.setLang(e.target.value));
  }
  const footer = document.getElementById('site-footer');
  if (footer) {
    footer.innerHTML = `
      <div class="foot-links">${[['/try', 'nav.try'], ['/dashboard', 'nav.demo'], ['/privacy', 'nav.privacy'], [GITHUB, 'nav.github']].map(link).join('')}</div>
      <span data-i18n="footer.text"></span>`;
  }
  // GITHUB_URL on the server wins over the default repo link.
  fetch('/api/demo-config').then((r) => r.json()).then((c) => {
    if (c?.links?.github) document.querySelectorAll('a[data-github]').forEach((a) => (a.href = c.links.github));
  }).catch(() => {});
  window.i18n.ready.then(() => window.i18n.apply(document));
})();
