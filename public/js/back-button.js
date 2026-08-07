document.addEventListener('DOMContentLoaded', function () {
  document.querySelectorAll('[data-back]').forEach(function (btn) {
    btn.addEventListener('click', function (event) {
      event.preventDefault();
      if (history.length <= 1) {
        window.location.pathname = '/';
      } else {
        history.back();
      }
    });
  });
});
