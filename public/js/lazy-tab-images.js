document.addEventListener('DOMContentLoaded', function () {
  document.querySelectorAll('.tabs.w-tabs').forEach(function (tabs) {
    const panes = [...tabs.querySelectorAll('.w-tab-pane')];

    function hydratePane(pane) {
      if (!pane) {
        return;
      }

      pane.querySelectorAll('img[data-src]').forEach(function (image) {
        image.src = image.dataset.src;
        image.removeAttribute('data-src');
      });
    }

    hydratePane(tabs.querySelector('.w-tab-pane.w--tab-active'));

    tabs.querySelectorAll('.w-tab-link[data-w-tab]').forEach(function (tab) {
      tab.addEventListener('click', function () {
        const tabName = tab.getAttribute('data-w-tab');
        hydratePane(panes.find(pane => pane.getAttribute('data-w-tab') === tabName));
      });
    });

    const observer = new MutationObserver(function (mutations) {
      mutations.forEach(function (mutation) {
        if (mutation.target.classList.contains('w--tab-active')) {
          hydratePane(mutation.target);
        }
      });
    });

    panes.forEach(function (pane) {
      observer.observe(pane, { attributes: true, attributeFilter: ['class'] });
    });
  });
});
