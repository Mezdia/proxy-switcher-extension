const ThemeTransition = (() => {

  /**
   * Default configuration.
   *   origin    — circle centre, "x% y%" (default: bottom‑left)
   *   duration  — animation length in ms
   *   easing    — CSS easing function
   *   maxRadius — final circle radius (percentage)
   *   zIndex    — overlay z‑index for the fallback path
   */
  const DEFAULTS = {
    origin:    '0% 100%',
    duration:   500,
    easing:    'cubic-bezier(0.4, 0, 0.2, 1)',
    maxRadius: '150%',
    zIndex:     9999,
  };

  /* ── a11y: honour OS‑level motion preference ── */
  const prefersReduced = (
    window.matchMedia &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches
  );

  /* ── Helper: resolve background colour for a theme ── */
  function resolveBg(theme) {
    return theme === 'light' ? '#fafafa' : '#09090b';
  }

  /* ── Path 1: View Transition API ── */
  async function vtTransition(applyTheme) {
    const vt = document.startViewTransition(() => {
      applyTheme();
    });

    await vt.finished;
  }

  /* ── Path 2: Full‑screen overlay fallback ── */
  async function overlayTransition(applyTheme, opts) {
    const html = document.documentElement;
    const isCurrentlyLight = html.classList.contains('light');
    const targetTheme = isCurrentlyLight ? 'dark' : 'light';
    const newBg = resolveBg(targetTheme);

    const overlay = document.createElement('div');
    overlay.setAttribute('data-theme-transition-overlay', '');
    overlay.style.background = newBg;
    overlay.style.clipPath = `circle(0 at ${opts.origin})`;
    document.body.appendChild(overlay);

    /* force layout so the initial clip‑path is painted */
    overlay.getBoundingClientRect();

    applyTheme();

    await new Promise(resolve => {
      let resolved = false;
      const done = () => {
        if (resolved) return;
        resolved = true;
        overlay.removeEventListener('transitionend', onEnd);
        clearTimeout(fallback);
        resolve();
      };
      const onEnd = () => done();
      const fallback = setTimeout(done, opts.duration + 100);

      overlay.addEventListener('transitionend', onEnd);

      requestAnimationFrame(() => {
        overlay.style.transition = `clip-path ${opts.duration}ms ${opts.easing}`;
        overlay.style.clipPath = `circle(${opts.maxRadius} at ${opts.origin})`;
      });
    });

    overlay.remove();
  }

  /* ── Public API ── */

  /**
   * Execute a theme change wrapped in the circle‑wave animation.
   *
   * @param {Function} applyTheme — synchronous callback that mutates the DOM
   *   (e.g. toggles a class on <html>)
   * @param {Object}   [overrides] — optional overrides for DEFAULTS keys
   * @returns {Promise<void>} resolves once the animation finishes
   */
  async function transition(applyTheme, overrides = {}) {
    const opts = { ...DEFAULTS, ...overrides };

    if (prefersReduced) {
      applyTheme();
      return;
    }

    if (document.startViewTransition) {
      return vtTransition(applyTheme);
    }

    return overlayTransition(applyTheme, opts);
  }

  return { transition, DEFAULTS };
})();