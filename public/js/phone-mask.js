document.addEventListener('DOMContentLoaded', function () {
  if (typeof IMask === 'undefined') {
    return;
  }

  document.querySelectorAll('[name="phone"]').forEach(function (phoneInput) {
    IMask(phoneInput, {
      mask: '+{7} (000) 000-00-00',
    });
  });
});
