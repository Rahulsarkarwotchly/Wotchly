// ============================================================
// Wotchly Keyboard Handler — keeps the video player visible
// whenever the on-screen keyboard opens (portrait + landscape).
// Chat condenses; the video never gets pushed off-screen.
// ============================================================

(function setupKeyboardHandling() {
  const vv = window.visualViewport;
  if (!vv) return;

  let rafPending = false;

  function apply() {
    rafPending = false;
    const keyboardOpen = vv.height < window.innerHeight - 120;
    document.body.classList.toggle('keyboard-open', keyboardOpen);
    // Pin the app to the visible viewport so the video stays on screen
    const root = document.documentElement;
    root.style.setProperty('--vvh', `${vv.height}px`);
    root.style.setProperty('--vv-offset-top', `${vv.offsetTop}px`);
  }

  function schedule() {
    if (rafPending) return;
    rafPending = true;
    requestAnimationFrame(apply);
  }

  vv.addEventListener('resize', schedule);
  vv.addEventListener('scroll', schedule);
  apply();

  // When the chat input loses focus, drop the keyboard state right away
  document.addEventListener('focusout', () => setTimeout(apply, 60));
})();
