(function () {
  'use strict';

  const timeoutMs = 15000;
  const successMs = 5000;
  function attribution() {
    const source = window.__ZVENFIT_ATTRIBUTION;
    if (source && typeof source.sync === 'function') {
      source.sync();
    }

    return source && typeof source.get === 'function' ? source.get() : {};
  }
  function messageFor(kind, status) {
    if (status === 429) {
      return 'Слишком много попыток. Подождите 10 минут и попробуйте снова.';
    }
    if (status === 400 || status === 413 || status === 415) {
      return kind === 'lead'
        ? 'Проверьте заполнение полей и попробуйте снова.'
        : 'Проверьте номер телефона и попробуйте снова.';
    }
    if (status === 503) {
      return kind === 'lead'
        ? 'Не удалось сохранить заявку. Попробуйте ещё раз через минуту.'
        : 'Не удалось сохранить подписку. Попробуйте ещё раз через минуту.';
    }

    return 'Сервис временно недоступен. Попробуйте ещё раз позже.';
  }
  async function post(apiUrl, payload) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);

    try {
      return await fetch(apiUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timeout);
    }
  }
  function mount(options) {
    const form = document.querySelector(options.form);
    const root = document.querySelector(options.root);
    if (!form || !root) {
      return;
    }
    const successBlock = root.querySelector('.success-message');
    const errorBlock = root.querySelector('.error-message');
    const errorText = errorBlock?.firstElementChild || errorBlock;
    const submitButton = form.querySelector('[type="submit"]');
    const defaultLabel = submitButton?.value || 'Отправить';
    let submissionId = '';
    let successTimer;

    function state(next, message) {
      clearTimeout(successTimer);
      successTimer = null;
      form.style.display = next === 'success' ? 'none' : '';
      if (successBlock) {
        successBlock.style.display = next === 'success' ? 'block' : 'none';
      }
      if (errorBlock) {
        errorBlock.style.display = next === 'error' ? 'block' : 'none';
        if (next === 'error') {
          if (message && errorText) {
            errorText.textContent = message;
          }
          errorBlock.focus();
        }
      }
    }

    function submitting(active) {
      form.setAttribute('aria-busy', String(active));
      if (submitButton) {
        submitButton.disabled = active;
        submitButton.value = active ? 'Отправляем...' : defaultLabel;
      }
    }

    state(null);
    options.ready?.();
    form.addEventListener('submit', async function (event) {
      event.preventDefault();
      event.stopImmediatePropagation();
      state(null);

      const payload = options.payload(
        form,
        submissionId ||
          (submissionId =
            typeof window.__ZVENFIT_CREATE_SUBMISSION_ID === 'function'
              ? window.__ZVENFIT_CREATE_SUBMISSION_ID()
              : ''),
      );
      payload.consents = { version: form.dataset.consentVersion, personal_data: form.dataset.consentMode === 'submit', marketing: form.dataset.marketingConsent === 'submit' };
      const utm = attribution();
      if (utm && Object.keys(utm).length) {
        payload.utm = utm;
      }
      if (options.validate && !options.validate(payload)) {
        return;
      }

      const apiUrl = (window.ZVENFIT_LEAD_API || '').trim();
      if (!apiUrl || apiUrl === '__LEAD_API_URL__') {
        state('error', 'Онлайн-форма временно недоступна. Позвоните нам: +7 (968) 844-00-88.');
        return;
      }

      submitting(true);
      try {
        const response = await post(apiUrl, payload);
        if (!response.ok) {
          state('error', messageFor(options.kind, response.status));
          return;
        }
        const data = await response.json().catch(function () {
          return {};
        });
        if (!data.ok) {
          state('error', 'Ответ сервиса не подтверждён. Попробуйте отправить форму ещё раз.');
          return;
        }

        form.reset();
        submissionId = '';
        options.afterReset?.();
        state('success');
        successTimer = setTimeout(function () {
          state(null);
        }, successMs);
      } catch (error) {
        state(
          'error',
          error && error.name === 'AbortError'
            ? 'Ответ занимает больше обычного. Проверьте интернет и попробуйте снова.'
            : 'Не удалось связаться с сервисом. Проверьте интернет и попробуйте снова.',
        );
      } finally {
        submitting(false);
      }
    }, true);
  }

  window.__ZVENFIT_FORM_CLIENT = { mount };
})();
