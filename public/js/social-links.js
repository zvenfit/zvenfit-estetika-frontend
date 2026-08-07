document.addEventListener('DOMContentLoaded', function () {
  document.querySelectorAll('.socials a[href="#"]').forEach(function (link) {
    link.setAttribute('aria-disabled', 'true');
    link.setAttribute('tabindex', '-1');
    link.addEventListener('click', function (event) {
      event.preventDefault();
    });
  });
});
