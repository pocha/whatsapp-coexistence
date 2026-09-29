let signupCode = null;
let signupWabaId = null;
let signupPhoneNumberId = null;

const onboardingStatus = document.getElementById('onboarding-status');
const loginBtn = document.getElementById('login-btn');
const completeBtn = document.getElementById('complete-btn');

async function init() {
  const res = await fetch('/api/config');
  const { appId, configId } = await res.json();

  window.fbAsyncInit = function () {
    FB.init({ appId, cookie: true, xfbml: false, version: 'v21.0' });
    onboardingStatus.textContent = 'Ready.';
    loginBtn.disabled = false;
  };

  const script = document.createElement('script');
  script.src = 'https://connect.facebook.net/en_US/sdk.js';
  script.async = true;
  document.body.appendChild(script);

  // Embedded Signup posts the new WABA's ids here once the popup finishes —
  // FB.login's own callback only gives you the `code`.
  window.addEventListener('message', (event) => {
    if (!event.origin.endsWith('facebook.com')) return;
    try {
      const data = JSON.parse(event.data);
      if (data.type === 'WA_EMBEDDED_SIGNUP' && data.event === 'FINISH') {
        signupWabaId = data.data.waba_id;
        signupPhoneNumberId = data.data.phone_number_id;
        onboardingStatus.textContent = `Signup finished. WABA ${signupWabaId}, phone number ${signupPhoneNumberId}.`;
        maybeEnableComplete();
      }
    } catch {
      // Not a JSON message we care about (Facebook posts other message shapes too).
    }
  });

  loginBtn.addEventListener('click', () => {
    FB.login(
      (response) => {
        if (response.authResponse && response.authResponse.code) {
          signupCode = response.authResponse.code;
          onboardingStatus.textContent = 'Got signup code, waiting for WABA details…';
          maybeEnableComplete();
        } else {
          onboardingStatus.textContent = 'Login cancelled or failed.';
        }
      },
      {
        config_id: configId,
        response_type: 'code',
        override_default_response_type: true,
        extras: { setup: {}, featureType: '', sessionInfoVersion: '3' },
      },
    );
  });
}

function maybeEnableComplete() {
  completeBtn.disabled = !(signupCode && signupWabaId && signupPhoneNumberId);
}

completeBtn.addEventListener('click', async () => {
  const overrideCallbackUrl = document.getElementById('override-url').value.trim() || undefined;
  const res = await fetch('/api/onboarding/complete', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      code: signupCode,
      wabaId: signupWabaId,
      phoneNumberId: signupPhoneNumberId,
      overrideCallbackUrl,
    }),
  });
  const body = await res.json();
  document.getElementById('onboarding-result').textContent = JSON.stringify(body, null, 2);
  document.getElementById('send-phone-number-id').value = signupPhoneNumberId || '';
  document.getElementById('tpl-waba-id').value = signupWabaId || '';
  document.getElementById('tpl-phone-number-id').value = signupPhoneNumberId || '';
});

document.getElementById('send-btn').addEventListener('click', async () => {
  const body = {
    phoneNumberId: document.getElementById('send-phone-number-id').value.trim(),
    to: document.getElementById('send-to').value.trim(),
    text: document.getElementById('send-text').value,
  };
  const res = await fetch('/api/test/send-message', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  document.getElementById('send-result').textContent = JSON.stringify(await res.json(), null, 2);
});

document.getElementById('tpl-btn').addEventListener('click', async () => {
  const body = {
    wabaId: document.getElementById('tpl-waba-id').value.trim(),
    phoneNumberId: document.getElementById('tpl-phone-number-id').value.trim(),
    name: document.getElementById('tpl-name').value.trim(),
    category: document.getElementById('tpl-category').value,
    language: document.getElementById('tpl-language').value.trim(),
    bodyText: document.getElementById('tpl-body').value,
  };
  const res = await fetch('/api/test/create-template', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  document.getElementById('tpl-result').textContent = JSON.stringify(await res.json(), null, 2);
});

async function refreshWebhookLog() {
  try {
    const res = await fetch('/api/webhook/log');
    const log = await res.json();
    document.getElementById('webhook-log').textContent = JSON.stringify(log, null, 2);
  } catch {
    // Ignore transient failures; next poll will retry.
  }
}
setInterval(refreshWebhookLog, 3000);
refreshWebhookLog();

init();
