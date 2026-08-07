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

  function setOpen(open) {
    options.style.display = open ? 'block' : 'none';
    selected.setAttribute('aria-expanded', String(open));
    if (!open) {
      currentIndex = -1;
      optionList.forEach(option => option.classList.remove('active'));
    }
  }

  function selectOption(option) {
    const value = option.dataset.value;
    selected.innerText = option.innerText;
    hidden.value = value;
    optionList.forEach(item => item.setAttribute('aria-selected', String(item === option)));
    setOpen(false);

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
    setOpen(options.style.display !== 'block');
  });

  document.addEventListener('click', function (event) {
    if (!event.target.closest('.custom-select')) {
      setOpen(false);
    }
  });

  optionList.forEach(function (option) {
    option.addEventListener('click', function () {
      selectOption(option);
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
        setOpen(true);
      } else if (optionList[currentIndex]) {
        selectOption(optionList[currentIndex]);
      }
      return;
    }
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') {
      return;
    }
    event.preventDefault();
    setOpen(true);
    const direction = event.key === 'ArrowDown' ? 1 : -1;
    currentIndex = (currentIndex + direction + optionList.length) % optionList.length;
    optionList.forEach(option => option.classList.remove('active'));
    optionList[currentIndex].classList.add('active');
  });

  const label = document.getElementById('label-select');
  if (label) {
    label.addEventListener('click', function (event) {
      event.stopPropagation();
      setOpen(options.style.display !== 'block');
      selected.focus();
    });
  }
});
