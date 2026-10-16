/*
 * Tiny i18n: loads /locales/<lang>.json and fills every [data-i18n] element (textContent),
 * [data-i18n-html] (innerHTML, trusted strings from our own files only), [data-i18n-ph] (placeholder)
 * and [data-i18n-title]. English is the default and the fallback for missing keys.
 * Add a language by adding locales/<lang>.json and listing it in LANGS.
 */
(function () {
  const LANGS = { en: 'English' };
  const stored = (() => { try { return localStorage.getItem('wessuwan.lang'); } catch { return null; } })();
  const lang = LANGS[stored] ? stored : 'en';
  let dict = {}, fallback = {};

  const get = (d, key) => key.split('.').reduce((o, k) => (o && o[k] !== undefined ? o[k] : undefined), d);
  function t(key, vars) {
    let s = get(dict, key) ?? get(fallback, key) ?? key;
    if (vars) for (const [k, v] of Object.entries(vars)) s = String(s).split(`{${k}}`).join(v);
    return s;
  }
  function apply(root = document) {
    root.querySelectorAll('[data-i18n]').forEach((el) => (el.textContent = t(el.dataset.i18n)));
    root.querySelectorAll('[data-i18n-html]').forEach((el) => (el.innerHTML = t(el.dataset.i18nHtml)));
    root.querySelectorAll('[data-i18n-ph]').forEach((el) => (el.placeholder = t(el.dataset.i18nPh)));
    root.querySelectorAll('[data-i18n-title]').forEach((el) => (el.title = t(el.dataset.i18nTitle)));
  }
  const load = (l) => fetch(`/locales/${l}.json`).then((r) => (r.ok ? r.json() : {})).catch(() => ({}));

  window.i18n = {
    t, apply, lang, langs: LANGS,
    setLang(l) { try { localStorage.setItem('wessuwan.lang', l); } catch {} location.reload(); },
    ready: Promise.all([load('en'), lang === 'en' ? null : load(lang)]).then(([en, other]) => {
      fallback = en; dict = other || en;
      document.documentElement.lang = lang;
      apply();
    }),
  };
  window.t = t;
})();
