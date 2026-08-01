// Legal pages — theme toggle + init
const saved = localStorage.getItem('wotchly_theme') || 'dark';
document.documentElement.setAttribute('data-theme', saved);
document.body.setAttribute('data-theme', saved);

const themeToggle = document.getElementById('themeToggle');
if (themeToggle) {
  themeToggle.setAttribute('aria-pressed', saved === 'light' ? 'true' : 'false');
  themeToggle.addEventListener('click', () => {
    const cur = document.documentElement.getAttribute('data-theme');
    const next = cur === 'light' ? 'dark' : 'light';
    document.documentElement.setAttribute('data-theme', next);
    document.body.setAttribute('data-theme', next);
    localStorage.setItem('wotchly_theme', next);
    themeToggle.setAttribute('aria-pressed', next === 'light' ? 'true' : 'false');
  });
}

// FAQ accordion — ensure only one open at a time (optional UX)
document.querySelectorAll('.faq-item').forEach(item => {
  item.addEventListener('toggle', () => {
    if (item.open) {
      document.querySelectorAll('.faq-item[open]').forEach(other => {
        if (other !== item) other.removeAttribute('open');
      });
    }
  });
});
