document.addEventListener('DOMContentLoaded', function () {
  window.__ZVENFIT_FORM_CLIENT?.mount({
    form: '#wf-form-Form',
    root: '#newsletter-send',
    kind: 'newsletter',
    payload(form, submissionId) {
      return {
        submission_id: submissionId,
        form_type: 'newsletter',
        phone: form.querySelector('[name="phone"]')?.value || '',
        website: form.querySelector('[name="website"]')?.value || '',
      };
    },
  });
});
