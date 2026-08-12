document.addEventListener('DOMContentLoaded', function () {
  const form = document.querySelector('#wf-form-tg-send');
  const serviceInput = form?.querySelector('[name="service"]');
  const serviceCombobox = form?.querySelector('[role="combobox"]');
  const serviceError = form?.querySelector('#contact-method-error');
  const defaultServiceLabel = 'Выберите удобный для вас вариант...';

  function setServiceValidity(isValid) {
    serviceCombobox?.setAttribute('aria-invalid', String(!isValid));
    if (serviceError) {
      serviceError.hidden = isValid;
    }
  }

  function resetCustomFields() {
    const selected = document.querySelector('.select-selected');
    const telegramField = document.querySelector('.telegram-wrapper');
    const telegramInput = document.querySelector('[name="telegram_username"]');

    if (selected) {
      selected.textContent = defaultServiceLabel;
      selected.setAttribute('aria-expanded', 'false');
      selected.removeAttribute('aria-activedescendant');
    }
    document.querySelectorAll('.select-options [role="option"]').forEach(option => {
      option.setAttribute('aria-selected', 'false');
      option.classList.remove('active');
    });
    setServiceValidity(true);
    if (telegramField) {
      telegramField.style.display = 'none';
    }
    if (telegramInput) {
      telegramInput.required = false;
      telegramInput.value = '';
    }
  }

  if (serviceInput) {
    serviceInput.addEventListener('change', function () {
      setServiceValidity(Boolean(serviceInput.value));
    });
  }

  window.__ZVENFIT_FORM_CLIENT?.mount({
    form: '#wf-form-tg-send',
    root: '#tg-send',
    kind: 'lead',
    ready() {
      setServiceValidity(true);
    },
    payload(activeForm, submissionId) {
      return {
        submission_id: submissionId,
        form_type: 'lead',
        name: activeForm.querySelector('[name="name"]')?.value || '',
        phone: activeForm.querySelector('[name="phone"]')?.value || '',
        service: activeForm.querySelector('[name="service"]')?.value || '',
        telegram_username: activeForm.querySelector('[name="telegram_username"]')?.value || '',
        website: activeForm.querySelector('[name="website"]')?.value || '',
      };
    },
    validate(payload) {
      const valid = Boolean(payload.service);
      setServiceValidity(valid);
      if (!valid) {
        serviceCombobox?.focus();
      }
      return valid;
    },
    afterReset: resetCustomFields,
  });
});
