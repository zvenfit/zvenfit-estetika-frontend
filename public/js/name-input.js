document.addEventListener('DOMContentLoaded', function () {
  const nameInput = document.querySelector('[name="name"]');
  if (!nameInput) {
    return;
  }

  nameInput.addEventListener('input', function () {
    this.value = this.value.replace(/[^a-zA-Zа-яА-ЯёЁ\s-]/g, '');
    this.style.borderColor = '#ECFDD3';
  });
});
