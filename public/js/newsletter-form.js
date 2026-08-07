document.addEventListener('DOMContentLoaded', function () {
  const form = document.querySelector('#wf-form-Form');
  const formRoot = document.querySelector('#newsletter-send');
  if (!form || !formRoot) {
    return;
  }

  const successBlock = formRoot.querySelector('.success-message');
  const errorBlock = formRoot.querySelector('.error-message');
  const submitButton = form.querySelector('[type="submit"]');
  const defaultSubmitLabel = submitButton ? submitButton.value : 'Подписаться';
  const successMessageMs = 5000;
  let successTimer;

  function clearSuccessTimer() {
    if (!successTimer) {
      return;
    }
    clearTimeout(successTimer);
    successTimer = null;
  }

  function setFormState(state) {
    clearSuccessTimer();

    if (!state) {
      form.style.display = '';
      if (successBlock) {
        successBlock.style.display = 'none';
      }
      if (errorBlock) {
        errorBlock.style.display = 'none';
      }

      return;
    }

    if (state === 'success') {
      form.style.display = 'none';
      if (successBlock) {
        successBlock.style.display = 'block';
      }
      if (errorBlock) {
        errorBlock.style.display = 'none';
      }
    } else if (state === 'error') {
      form.style.display = '';
      if (successBlock) {
        successBlock.style.display = 'none';
      }
      if (errorBlock) {
        errorBlock.style.display = 'block';
      }
    }
  }

  function setSubmitting(isSubmitting) {
    if (!submitButton) {
      return;
    }
    submitButton.disabled = isSubmitting;
    submitButton.value = isSubmitting ? 'Отправляем...' : defaultSubmitLabel;
  }

  setFormState(null);

  form.addEventListener('submit', async function (event) {
    event.preventDefault();
    setFormState(null);

    const apiUrl = (window.ZVENFIT_LEAD_API || '').trim();
    if (!apiUrl || apiUrl === '__LEAD_API_URL__') {
      setFormState('error');

      return;
    }

    if (window.__ZVENFIT_ATTRIBUTION && typeof window.__ZVENFIT_ATTRIBUTION.sync === 'function') {
      window.__ZVENFIT_ATTRIBUTION.sync();
    }

    const utm =
      window.__ZVENFIT_ATTRIBUTION && typeof window.__ZVENFIT_ATTRIBUTION.get === 'function'
        ? window.__ZVENFIT_ATTRIBUTION.get()
        : {};

    const payload = {
      form_type: 'newsletter',
      phone: form.querySelector('[name="phone"]')?.value || '',
      website: form.querySelector('[name="website"]')?.value || '',
    };

    if (utm && Object.keys(utm).length > 0) {
      payload.utm = utm;
    }

    setSubmitting(true);

    try {
      const response = await fetch(apiUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });

      if (!response.ok) {
        setFormState('error');

        return;
      }

      const data = await response.json();
      if (!data.ok) {
        setFormState('error');

        return;
      }

      form.reset();
      setFormState('success');
      successTimer = setTimeout(function () {
        setFormState(null);
      }, successMessageMs);
    } catch {
      setFormState('error');
    } finally {
      setSubmitting(false);
    }
  });
});
