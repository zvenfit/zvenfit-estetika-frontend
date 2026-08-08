document.addEventListener('DOMContentLoaded', function () {
  const selected = document.querySelector('.select-selected');
  const options = document.querySelector('.select-options');
  const hidden = document.querySelector('input[name="service"]');
  const telegramField = document.querySelector('.telegram-wrapper');
  const telegramInput = document.querySelector('[name="telegram_username"]');
  const optionList = [...document.querySelectorAll('.select-options [role="option"]')];

  if (!selected || !options || !hidden) {
    return;
  }

  let currentIndex = -1;

  function setActiveOption(index) {
    currentIndex = index;
    optionList.forEach((option, optionIndex) => {
      option.classList.toggle('active', optionIndex === currentIndex);
    });

    const activeOption = optionList[currentIndex];
    if (activeOption) {
      selected.setAttribute('aria-activedescendant', activeOption.id);
    } else {
      selected.removeAttribute('aria-activedescendant');
    }
  }

  function getSelectedIndex() {
    return optionList.findIndex(option => option.getAttribute('aria-selected') === 'true');
  }

  function setOpen(open, activateOption = false) {
    options.style.display = open ? 'block' : 'none';
    selected.setAttribute('aria-expanded', String(open));

    if (open && activateOption) {
      const selectedIndex = getSelectedIndex();
      setActiveOption(selectedIndex >= 0 ? selectedIndex : 0);
    } else if (!open) {
      setActiveOption(-1);
    }
  }

  function selectOption(option) {
    const value = option.dataset.value;
    selected.innerText = option.innerText;
    hidden.value = value;
    optionList.forEach(item => item.setAttribute('aria-selected', String(item === option)));
    setOpen(false);
    hidden.dispatchEvent(new Event('change', { bubbles: true }));

    if (value === 'Telegram') {
      if (telegramField) {
        telegramField.style.display = 'block';
      }
      if (telegramInput) {
        telegramInput.required = true;
      }
    } else {
      if (telegramField) {
        telegramField.style.display = 'none';
      }
      if (telegramInput) {
        telegramInput.required = false;
        telegramInput.value = '';
      }
    }
  }

  selected.addEventListener('click', function () {
    const shouldOpen = options.style.display !== 'block';
    setOpen(shouldOpen, shouldOpen);
  });

  document.addEventListener('click', function (event) {
    if (!event.target.closest('.custom-select')) {
      setOpen(false);
    }
  });

  optionList.forEach(function (option) {
    option.addEventListener('click', function () {
      selectOption(option);
      selected.focus();
    });
  });

  selected.addEventListener('keydown', function (event) {
    if (event.key === 'Escape') {
      setOpen(false);
      return;
    }
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      if (options.style.display !== 'block') {
        setOpen(true, true);
      } else if (optionList[currentIndex]) {
        selectOption(optionList[currentIndex]);
      }
      return;
    }
    if (event.key === 'Tab') {
      setOpen(false);
      return;
    }
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') {
      return;
    }
    event.preventDefault();
    const wasOpen = options.style.display === 'block';
    setOpen(true, !wasOpen);
    const direction = event.key === 'ArrowDown' ? 1 : -1;
    if (wasOpen) {
      setActiveOption((currentIndex + direction + optionList.length) % optionList.length);
    }
  });

  const label = document.getElementById('contact-method-label');
  if (label) {
    label.addEventListener('click', function (event) {
      event.stopPropagation();
      const shouldOpen = options.style.display !== 'block';
      setOpen(shouldOpen, shouldOpen);
      selected.focus();
    });
  }
});
