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

  if (res.ok) {
    const pendingTasks = document.getElementById('pending-tasks');
    const snippet = pendingTasks.querySelector('.snippet');
    const noEndpointWarning = pendingTasks.querySelector('.no-endpoint-warning');

    if (overrideCallbackUrl) {
      document.getElementById('pending-endpoint').textContent = overrideCallbackUrl;
      snippet.classList.remove('hidden');
      noEndpointWarning.classList.add('hidden');
    } else {
      // No override was set, so incoming messages go to this app's own
      // /webhook — which just acks and does nothing. There's no endpoint of
      // theirs to point the smb_message_echoes guidance at yet.
      snippet.classList.add('hidden');
      noEndpointWarning.classList.remove('hidden');
    }
    pendingTasks.classList.remove('hidden');
  }
});

init();
